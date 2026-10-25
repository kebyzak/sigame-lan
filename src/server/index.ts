// Local SIGame server: HTTP (static client, upload, media) + Socket.IO game sync.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { Server, type Socket } from 'socket.io';
import type { Ack, GameView, HostAction, LanInfo, PackageSummary } from '../shared/types.js';
import { Game, GameError } from './game/engine.js';
import { isLoopback, lanAddresses } from './net.js';
import { importSiq } from './siq/parser.js';
import { Store } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 3000);
const BIND = process.env.HOST ?? '0.0.0.0';
const MB = 1024 * 1024;
const FALSE_START_MS = Number(process.env.FALSE_START_MS ?? 1000);
const TIMER_SCALE = Number(process.env.TIMER_SCALE ?? 1);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB ?? 500) * MB;
const CLIENT_DIR = path.join(ROOT, 'dist', 'client');

const store = new Store(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'));
const hostToken = store.hostToken();
const state = store.loadState();
const pkg = store.loadPackage(state.packageId);
if (state.packageId && !pkg) {
  console.warn('Сохранённый пакет не найден — игра сброшена в лобби.');
  state.packageId = null;
  state.phase = 'lobby';
  state.question = null;
}

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 10000,
  pingTimeout: 8000,
  perMessageDeflate: false,
  connectionStateRecovery: undefined,
});

// ---------- game + broadcasting ----------

let broadcastPending = false;
const game = new Game(state, pkg, () => {
  store.saveState(game.state);
  if (broadcastPending) return;
  broadcastPending = true;
  // Coalesce mutations from the same tick into a single broadcast.
  setImmediate(broadcast);
}, FALSE_START_MS, TIMER_SCALE);

function broadcast() {
  broadcastPending = false;
  const cache = new Map<string, GameView>();
  const viewFor = (s: Socket): GameView | null => {
    const role = s.data.role as 'host' | 'player' | 'screen' | undefined;
    if (!role) return null;
    const key = role === 'player' ? `p:${s.data.playerId}` : role;
    let v = cache.get(key);
    if (!v) {
      v = game.view(role, s.data.playerId);
      cache.set(key, v);
    }
    return v;
  };
  for (const s of io.sockets.sockets.values()) {
    const v = viewFor(s);
    if (v) s.emit('state', v);
  }
}

// ---------- HTTP ----------

const hostHeaderOk = (h: string | undefined) => !!h && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h);
const isHostToken = (t: unknown) =>
  typeof t === 'string' && t.length === hostToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(hostToken));

let lanInfoCache: { at: number; info: LanInfo } | null = null;
async function lanInfo(): Promise<LanInfo> {
  if (lanInfoCache && Date.now() - lanInfoCache.at < 15000) return lanInfoCache.info;
  const addresses = await Promise.all(
    lanAddresses().map(async (a) => {
      const url = `http://${a.address}:${PORT}/`;
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return { ...a, url, qrSvg };
    }),
  );
  const info = { port: PORT, addresses };
  lanInfoCache = { at: Date.now(), info };
  return info;
}

app.get('/api/info', async (_req, res) => {
  res.json(await lanInfo());
});

// The moderator token is handed out only to the machine running the server.
app.get('/api/host/claim', (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !hostHeaderOk(req.headers.host)) {
    res.status(403).json({ error: 'Доступ ведущего возможен только с компьютера, на котором запущен сервер' });
    return;
  }
  res.json({ token: hostToken });
});

let importing = false;
app.post('/api/host/upload', (req, res) => {
  if (!isHostToken(req.headers['x-host-token'])) {
    res.status(403).json({ error: 'Нет прав ведущего' });
    return;
  }
  if (importing) {
    res.status(409).json({ error: 'Пакет уже загружается' });
    return;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD) {
    res.status(413).json({ error: `Файл больше ${MAX_UPLOAD / MB} МБ` });
    req.resume();
    return;
  }
  importing = true;
  const tmp = path.join(store.uploadsDir, crypto.randomBytes(8).toString('hex') + '.siq');
  const out = fs.createWriteStream(tmp);
  let size = 0;
  let aborted = false;
  const finish = (status: number, body: unknown) => {
    importing = false;
    fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) res.status(status).json(body);
  };
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_UPLOAD && !aborted) {
      aborted = true;
      req.unpipe(out);
      out.destroy();
      finish(413, { error: `Файл больше ${MAX_UPLOAD / MB} МБ` });
      req.resume();
    }
  });
  req.on('aborted', () => {
    aborted = true;
    out.destroy();
    importing = false;
    fs.rm(tmp, { force: true }, () => {});
  });
  req.pipe(out);
  out.on('finish', async () => {
    if (aborted) return;
    const id = crypto.randomUUID();
    const dir = store.packageDir(id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const p = await importSiq(tmp, dir, {
        limits: { maxEntries: 10000, maxTotalUncompressed: 2 * MAX_UPLOAD + 100 * MB, maxEntryUncompressed: MAX_UPLOAD, maxRatio: 200 },
        maxContentXml: 50 * MB,
      });
      p.id = id;
      store.savePackage(p);
      game.setPackage(p);
      store.prunePackages(id);
      store.writeNow(game.state);
      const summary: PackageSummary = {
        id,
        name: p.name,
        author: p.author,
        rounds: p.rounds.map((r) => ({
          name: r.name,
          type: r.type,
          themes: r.themes.length,
          questions: r.themes.reduce((n, t) => n + t.questions.length, 0),
        })),
        mediaCount: Object.keys(p.media).length,
        warnings: p.warnings,
      };
      console.log(`Загружен пакет «${p.name}»: ${summary.rounds.length} раунд(ов), ${summary.mediaCount} медиафайлов`);
      finish(200, summary);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.error('Ошибка импорта пакета:', (e as Error).message);
      finish(400, { error: (e as Error).message || 'Не удалось прочитать пакет' });
    }
  });
  out.on('error', () => finish(500, { error: 'Ошибка записи файла' }));
});

// Media is addressed by unguessable ids, which are only sent to players once content is revealed.
app.get('/media/:pkgId/:mediaId', (req, res) => {
  const p = game.pkg;
  const m = p && req.params.pkgId === p.id ? p.media[req.params.mediaId] : undefined;
  if (!p || !m || !Object.hasOwn(p.media, req.params.mediaId)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', m.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox");
  // `root` keeps the dotfile check relative to the media folder (the install path itself may contain dot-folders).
  res.sendFile(path.basename(m.file), { root: path.join(store.packageDir(p.id), 'media'), maxAge: '1d', dotfiles: 'deny' });
});

if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|media\/|socket\.io\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('Клиент не собран. Выполните: npm run build');
  });
}

// ---------- Socket.IO ----------

type AckFn = (a: Ack & Record<string, unknown>) => void;
const safeAck = (fn: unknown): AckFn => (typeof fn === 'function' ? (fn as AckFn) : () => {});

function attachPlayer(socket: Socket, playerId: string) {
  if (socket.data.playerId === playerId) return;
  detach(socket);
  socket.data.role = 'player';
  socket.data.playerId = playerId;
  socket.join(`player:${playerId}`);
  game.setOnline(playerId, 1);
}

function detach(socket: Socket) {
  if (socket.data.role === 'player' && socket.data.playerId) {
    socket.leave(`player:${socket.data.playerId}`);
    game.setOnline(socket.data.playerId, -1);
  }
  socket.data.role = undefined;
  socket.data.playerId = undefined;
}

io.on('connection', (socket) => {
  socket.on('host:auth', (data: { token?: string }, cb) => {
    const ack = safeAck(cb);
    if (!isHostToken(data?.token)) return ack({ ok: false, error: 'Неверный ключ ведущего' });
    detach(socket);
    socket.data.role = 'host';
    ack({ ok: true });
    socket.emit('state', game.view('host'));
  });

  socket.on('screen:join', (_d, cb) => {
    detach(socket);
    socket.data.role = 'screen';
    safeAck(cb)({ ok: true });
    socket.emit('state', game.view('screen'));
  });

  socket.on('player:join', (data: { name?: string; token?: string }, cb) => {
    const ack = safeAck(cb);
    try {
      let p = game.playerByToken(data?.token);
      if (!p) {
        if (data?.token && !data?.name) return ack({ ok: false, error: 'unknown-token' });
        p = game.join(data?.name);
      }
      attachPlayer(socket, p.id);
      ack({ ok: true, playerId: p.id, token: p.token, name: p.name });
      socket.emit('state', game.view('player', p.id));
    } catch (e) {
      ack({ ok: false, error: e instanceof GameError ? e.message : 'Ошибка входа' });
    }
  });

  socket.on('buzz', (_d, cb) => {
    if (socket.data.role !== 'player') return;
    const r = game.buzz(socket.data.playerId);
    safeAck(cb)({ ok: true, ...r });
  });

  socket.on('player:stake', (data: { amount?: number }, cb) => {
    const ack = safeAck(cb);
    if (socket.data.role !== 'player') return ack({ ok: false, error: 'Нет доступа' });
    try {
      game.submitStake(socket.data.playerId, data?.amount);
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e instanceof GameError ? e.message : 'Ошибка' });
    }
  });

  socket.on('player:answer', (data: { text?: string }, cb) => {
    const ack = safeAck(cb);
    if (socket.data.role !== 'player') return ack({ ok: false, error: 'Нет доступа' });
    try {
      game.submitAnswer(socket.data.playerId, data?.text);
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e instanceof GameError ? e.message : 'Ошибка' });
    }
  });

  socket.on('player:leave', (_d, cb) => {
    detach(socket);
    safeAck(cb)({ ok: true });
  });

  socket.on('host:action', (action: HostAction, cb) => {
    const ack = safeAck(cb);
    if (socket.data.role !== 'host') return ack({ ok: false, error: 'Только ведущий может это сделать' });
    try {
      const kicked = action?.type === 'kickPlayer' ? String(action.playerId) : null;
      game.hostAction(action);
      if (kicked) {
        for (const s of io.sockets.sockets.values()) {
          if (s.data.playerId === kicked) {
            s.data.role = undefined;
            s.data.playerId = undefined;
            s.emit('kicked');
          }
        }
        game.online.delete(kicked);
      }
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e instanceof GameError ? e.message : 'Ошибка' });
      if (!(e instanceof GameError)) console.error(e);
    }
  });

  socket.on('disconnect', () => detach(socket));
});

// ---------- start ----------

function shutdown() {
  store.writeNow(game.state);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, BIND, async () => {
  const info = await lanInfo();
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  СИ-Игра (LAN) запущена\n${line}`);
  console.log(`  Ведущий:  http://localhost:${PORT}/host`);
  if (info.addresses.length === 0) {
    console.log('  ⚠ Не найден IPv4-адрес в локальной сети. Подключитесь к Wi-Fi.');
  } else {
    for (const a of info.addresses) console.log(`  Игроки:   ${a.url}   (${a.iface})`);
    const main = info.addresses[0];
    console.log(`\n  Ведущий с другого устройства (держите в секрете):\n  ${main.url}host?key=${hostToken}\n`);
    console.log('  QR-код для игроков:');
    console.log(await QRCode.toString(main.url, { type: 'terminal', small: true }));
  }
  console.log(line);
});
