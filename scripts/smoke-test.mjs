// End-to-end smoke test: starts a real server on a temp data dir and plays through it.
// Usage: npm run build && node scripts/smoke-test.mjs path/to/package.siq
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIQ = process.argv[2] ?? process.env.SIQ;
if (!SIQ || !fs.existsSync(SIQ)) {
  console.error('Укажите путь к .siq: node scripts/smoke-test.mjs package.siq');
  process.exit(2);
}
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sigame-test-'));

let server;
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'dist-server/server/index.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FALSE_START_MS: '3000', TIMER_SCALE: '0.2' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Ведущий:')) resolve();
    });
    server.stderr.on('data', (d) => process.stderr.write(d));
    server.on('exit', (c) => c && reject(new Error('server exited ' + c)));
  });
}
async function stopServer() {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
}

class Client {
  constructor() {
    this.view = null;
    this.socket = io(BASE, { transports: ['websocket'], forceNew: true });
    this.socket.on('state', (v) => (this.view = v));
  }
  ready() {
    return new Promise((r) => (this.socket.connected ? r() : this.socket.once('connect', r)));
  }
  emit(ev, data) {
    return new Promise((r) => this.socket.emit(ev, data, r));
  }
  host(action) {
    return this.emit('host:action', action);
  }
  close() {
    this.socket.disconnect();
  }
}

async function upload(file, token) {
  const r = await fetch(`${BASE}/api/host/upload`, {
    method: 'POST',
    headers: { 'x-host-token': token, 'content-type': 'application/octet-stream' },
    body: fs.readFileSync(file),
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  await startServer();
  console.log(`Сервер запущен на ${BASE}`);

  console.log('\n[HTTP и безопасность]');
  const claim = await fetch(`${BASE}/api/host/claim`).then((r) => r.json());
  ok(typeof claim.token === 'string' && claim.token.length >= 32, 'ведущий получает ключ с localhost');
  const lanIp = (await fetch(`${BASE}/api/info`).then((r) => r.json())).addresses[0]?.address;
  if (lanIp) {
    const r = await fetch(`http://${lanIp}:${PORT}/api/host/claim`).catch(() => null);
    ok(r?.status === 403, `ключ ведущего НЕ выдаётся по LAN-адресу ${lanIp}`);
    const info = await fetch(`http://${lanIp}:${PORT}/api/info`).then((r) => r.text());
    ok(!info.includes(claim.token), 'QR/инфо для игроков не содержит ключ ведущего');
  }
  const badUp = await upload(SIQ, 'wrong');
  ok(badUp.status === 403, 'загрузка без ключа ведущего запрещена');

  // Malicious archives.
  const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigame-evil-'));
  const py = `
import zipfile, sys
d = sys.argv[1]
with zipfile.ZipFile(d + '/trav.siq', 'w') as z:
    z.writestr('content.xml', '<package name="x" version="5"><rounds><round name="1"><themes><theme name="t"><questions><question price="100"><params><param name="question" type="content"><item type="image" isRef="True">../../evil.jpg</item></param></params><right><answer>a</answer></right></question></questions></theme></themes></round></rounds></package>')
    z.writestr('../../evil.jpg', 'x')
with zipfile.ZipFile(d + '/bomb.siq', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('content.xml', '<package name="b" version="5"><rounds><round name="1"/></rounds></package>')
    z.writestr('Images/zero.jpg', b'\\0' * (60 * 1024 * 1024))
with zipfile.ZipFile(d + '/xxe.siq', 'w') as z:
    z.writestr('content.xml', '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY a "aaaa">]><package name="&a;"><rounds/></package>')
`;
  execFileSync('python3', ['-I', '-c', py, evilDir]);
  const trav = await upload(path.join(evilDir, 'trav.siq'), claim.token);
  ok(trav.status === 400 || (trav.status === 200 && !fs.existsSync(path.join(DATA, '..', 'evil.jpg'))), `ZIP с ../ отклонён или обезврежен (${trav.status}: ${trav.body.error ?? 'ok'})`);
  const bomb = await upload(path.join(evilDir, 'bomb.siq'), claim.token);
  ok(bomb.status === 400, `ZIP-бомба отклонена (${bomb.body.error})`);
  const xxe = await upload(path.join(evilDir, 'xxe.siq'), claim.token);
  ok(xxe.status === 400, `DOCTYPE/ENTITY отклонён (${xxe.body.error})`);
  fs.rmSync(evilDir, { recursive: true, force: true });

  console.log('\n[Импорт пакета]');
  const t0 = Date.now();
  const up = await upload(SIQ, claim.token);
  ok(up.status === 200, `пакет загружен: «${up.body.name}» за ${Date.now() - t0} мс`);
  ok(up.body.rounds?.length > 0, `раунды: ${up.body.rounds?.map((r) => `${r.name}(${r.themes}т/${r.questions}в)`).join(', ')}`);
  console.log(`    медиафайлов: ${up.body.mediaCount}, предупреждений: ${up.body.warnings?.length}`);

  console.log('\n[Подключение]');
  const host = new Client();
  await host.ready();
  ok((await host.emit('host:auth', { token: claim.token })).ok, 'ведущий авторизован');
  const badHost = new Client();
  await badHost.ready();
  ok(!(await badHost.emit('host:auth', { token: 'x'.repeat(48) })).ok, 'неверный ключ ведущего отклонён');
  badHost.close();

  const names = ['Аня', 'Борис', 'Вика', 'Глеб', 'Даша'];
  const players = [];
  for (const n of names) {
    const c = new Client();
    await c.ready();
    const r = await c.emit('player:join', { name: n });
    c.id = r.playerId;
    c.token = r.token;
    players.push(c);
  }
  ok(players.every((p) => p.id), `${players.length} игроков подключились`);
  const dup = new Client();
  await dup.ready();
  ok(!(await dup.emit('player:join', { name: 'аня' })).ok, 'повторное имя отклонено');
  dup.close();

  const hack = await players[0].host({ type: 'adjustScore', playerId: players[0].id, delta: 10000 });
  ok(!hack.ok, 'игрок не может выполнять действия ведущего');

  console.log('\n[Игра]');
  await host.host({ type: 'startGame' });
  await sleep(100);
  ok(players.every((p) => p.view?.phase === 'board'), 'все игроки видят табло');
  ok(JSON.stringify(players[0].view.board) === JSON.stringify(host.view.board), 'табло синхронизировано');

  // Find a question with answer media to check hiding.
  const pkgDir = path.join(DATA, 'packages', up.body.id);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  let target = { t: 0, q: 0 };
  pkg.rounds[0].themes.forEach((th, ti) =>
    th.questions.forEach((qq, qi) => {
      if (qq.answer.some((a) => a.mediaId) && target.media === undefined) target = { t: ti, q: qi, media: qq.answer.find((a) => a.mediaId).mediaId };
    }),
  );
  const pq = pkg.rounds[0].themes[target.t].questions[target.q];
  await host.host({ type: 'selectQuestion', theme: target.t, question: target.q });
  await sleep(100);
  const pv = JSON.stringify(players[1].view);
  ok(players[1].view.question && players[1].view.question.answer === null, 'игрок не получает ответ до раскрытия');
  ok(!pq.right.some((r) => r.length > 2 && pv.includes(r)), 'текст правильного ответа отсутствует в данных игрока');
  if (target.media) ok(!pv.includes(target.media), 'ссылка на медиа ответа отсутствует в данных игрока');
  ok(host.view.question.answer?.right?.length > 0, 'ведущий видит ответ');

  const mediaUrl = players[1].view.question.content.find((c) => c.url)?.url;
  if (mediaUrl) {
    const r = await fetch(BASE + mediaUrl);
    ok(r.status === 200 && r.headers.get('content-type')?.match(/image|audio|video/), `медиа вопроса отдаётся (${r.headers.get('content-type')})`);
  }
  ok((await fetch(`${BASE}/media/${up.body.id}/deadbeefdeadbeefdeadbeef`)).status === 404, 'несуществующее медиа → 404');
  ok((await fetch(`${BASE}/media/..%2F..%2Fstate.json/x`)).status === 404, 'path traversal в /media → 404');

  // Early buzz is a false start.
  const early = await players[0].emit('buzz');
  await sleep(50);
  ok(host.view.question.buzzer.winnerId === null, 'нажатие до открытия кнопки не засчитано');
  ok(early.lockMs > 0 && host.view.question.buzzer.falseStarts.includes(players[0].id), `фальстарт зафиксирован, блокировка ${early.lockMs} мс`);
  ok(players[0].view.question.myLockMs > 0 && players[1].view.question.myLockMs === 0, 'блокировка видна только нарушителю');

  const auto0 = host.view.question.auto;
  const hasMedia = pq.question.some((i) => i.kind !== 'text' && !i.missing);
  ok(
    auto0 && auto0.media === hasMedia && (hasMedia ? auto0.delayMs >= 3000 && auto0.delayMs <= 7000 : auto0.delayMs >= 1500 && auto0.delayMs <= 12000),
    `авто-задержка запланирована: ${auto0?.delayMs} мс (${hasMedia ? 'медиа' : 'текст'})`,
  );
  ok(players.every((p) => p.view.question.auto === undefined), 'игроки не получают время активации');
  await host.host({ type: 'openBuzzer' });
  await sleep(50);
  ok(players.every((p) => p.view.question.buzzer.open) && host.view.question.auto.mode === 'done', 'ведущий открыл кнопку сразу (авто-таймер отменён)');
  // Everyone presses at once, some twice.
  const results = await Promise.all(players.flatMap((p) => [p.emit('buzz'), p.emit('buzz')]));
  await sleep(100);
  const winners = results.filter((r) => r?.won).length;
  ok(winners === 1, `ровно один победитель при одновременном нажатии (побед: ${winners})`);
  const w1 = host.view.question.buzzer.winnerId;
  ok(w1 !== players[0].id, 'игрок с фальстартом не может выиграть кнопку во время блокировки');
  ok(players.every((p) => p.view.question.buzzer.winnerId === w1), `все видят победителя: ${host.view.players.find((p) => p.id === w1)?.name}`);
  ok(!host.view.question.buzzer.open, 'кнопка заблокирована после победы');
  const order = host.view.question.buzzer.order;
  ok(new Set(order.map((o) => o.playerId)).size === order.length, `дубликаты нажатий не записаны (${order.length} в очереди)`);

  await host.host({ type: 'judge', correct: false });
  await sleep(50);
  const price = pq.price;
  ok(host.view.players.find((p) => p.id === w1).score === -price, `неверный ответ: −${price}`);
  await host.host({ type: 'openBuzzer' });
  await sleep(30);
  const loser = players.find((p) => p.id === w1);
  ok(!(await loser.emit('buzz')).won, 'ответивший неверно не может нажать снова');
  const second = players.find((p) => p.id !== w1 && p !== players[0]); // players[0] is serving a false-start lockout
  ok((await second.emit('buzz')).won, 'другой игрок перехватывает');
  await host.host({ type: 'judge', correct: true });
  await sleep(50);
  ok(second.view.me.score === price, `верный ответ: +${price}`);
  ok(second.view.question.stage === 'answer' && second.view.question.answer?.right?.length > 0, 'после верного ответа ответ раскрыт игрокам');
  ok(host.view.chooserId === second.id, 'выбирает ответивший верно');
  await host.host({ type: 'finishQuestion' });
  await sleep(50);
  ok(players[0].view.board.themes[target.t].questions[target.q].used, 'сыгранный вопрос отмечен на табло');

  // Skipping a question still shows the answer to players before the board returns.
  await host.host({ type: 'selectQuestion', theme: (target.t + 1) % pkg.rounds[0].themes.length, question: 0 });
  await host.host({ type: 'skipQuestion' });
  await sleep(50);
  ok(players[1].view.question?.stage === 'answer' && players[1].view.question.answer?.right?.length > 0, 'при пропуске игроки видят правильный ответ');
  await host.host({ type: 'finishQuestion' });
  await sleep(50);
  ok(players[1].view.phase === 'board' && !!players[1].view.lastAnswer?.text, `на табло виден прошлый ответ: «${players[1].view.lastAnswer?.text}»`);

  console.log('\n[Ручные действия ведущего]');
  const s2 = players[2].view.me.score;
  await host.host({ type: 'adjustScore', playerId: players[2].id, delta: 300 });
  await host.host({ type: 'setScore', playerId: players[3].id, score: 1000 });
  await sleep(50);
  ok(players[2].view.me.score === s2 + 300 && players[3].view.me.score === 1000, 'ручное изменение счёта');

  console.log('\n[Переподключение]');
  const p0 = players[0];
  p0.close();
  await sleep(100);
  ok(host.view.players.find((p) => p.id === p0.id).online === false, 'отключившийся игрок помечен offline');
  const re = new Client();
  await re.ready();
  const rr = await re.emit('player:join', { token: p0.token });
  await sleep(50);
  ok(rr.ok && rr.playerId === p0.id, 'игрок вернулся по токену с тем же id');
  ok(host.view.players.length === names.length, 'игрок не задублировался');
  ok(host.view.players.find((p) => p.id === p0.id).online, 'игрок снова online');
  players[0] = Object.assign(re, { id: p0.id, token: p0.token });

  console.log('\n[Перезапуск сервера]');
  const scoresBefore = JSON.stringify(host.view.players.map((p) => [p.id, p.score]));
  const usedBefore = JSON.stringify(host.view.board);
  for (const c of [host, ...players]) c.close();
  await stopServer();
  await startServer();
  const host2 = new Client();
  await host2.ready();
  ok((await host2.emit('host:auth', { token: claim.token })).ok, 'ключ ведущего сохранён после перезапуска');
  await sleep(100);
  ok(JSON.stringify(host2.view.players.map((p) => [p.id, p.score])) === scoresBefore, 'счёт сохранён после перезапуска');
  ok(JSON.stringify(host2.view.board) === usedBefore, 'табло сохранено после перезапуска');
  const ps = [];
  for (const p of players) {
    const c = new Client();
    await c.ready();
    const r = await c.emit('player:join', { token: p.token });
    c.id = r.playerId;
    ps.push(c);
  }
  ok(ps.every((c, i) => c.id === players[i].id), 'игроки восстановились после перезапуска');

  console.log('\n[Авто-кнопка]');
  await host2.host({ type: 'setRound', index: 1 });
  await sleep(50);
  const r1 = pkg.rounds[1];
  const all1 = r1.themes.flatMap((t, ti) => t.questions.map((q, qi) => ({ t: ti, q: qi, pq: q })));
  const simple = all1.filter((x) => x.pq.type === 'simple');
  const words = (x) =>
    [...x.pq.question.map((i) => i.text ?? ''), ...(x.pq.options ?? []).flatMap((o) => o.content.map((c) => c.text ?? ''))]
      .join(' ')
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const texts = simple.filter((x) => x.pq.question.every((i) => i.kind === 'text')).sort((a, b) => words(a) - words(b));
  const shortQ = texts[0];
  const longQ = texts[texts.length - 1];
  const imageQ = simple.find((x) => x.pq.question.some((i) => i.kind === 'image') && !x.pq.question.some((i) => i.kind === 'audio' || i.kind === 'video'));
  const audioQ = simple.find((x) => x.pq.question.some((i) => i.kind === 'audio'));
  const play = (x) => host2.host({ type: 'selectQuestion', theme: x.t, question: x.q });
  const done = async () => {
    await host2.host({ type: 'skipQuestion' });
    await host2.host({ type: 'finishQuestion' });
    await sleep(30);
  };
  const deadline = () => Date.now() + (host2.view.question.auto.remainingMs ?? 0);

  // Short text: moderator disables the buzzer before it opens.
  await play(shortQ);
  await sleep(50);
  const dShort = host2.view.question.auto.delayMs;
  ok(!host2.view.question.auto.media && dShort >= 1500, `короткий текст (${words(shortQ)} сл.): задержка ${dShort} мс`);
  await host2.host({ type: 'closeBuzzer' });
  await sleep(dShort + 300);
  ok(!host2.view.question.buzzer.open && host2.view.question.auto.mode === 'done', 'ведущий отключил авто-кнопку — она не открылась');
  await done();

  // Long text: opens by itself after the reading-time delay, simultaneously for everyone.
  await play(longQ);
  const tLong = Date.now();
  await sleep(50);
  const dLong = host2.view.question.auto.delayMs;
  ok(dLong > dShort && dLong <= 12000, `длинный текст (${words(longQ)} сл.): задержка ${dLong} мс > ${dShort} мс`);
  const opened = new Map();
  for (const c of ps) c.socket.on('state', (v) => v.question?.buzzer.open && !opened.has(c.id) && opened.set(c.id, Date.now()));
  const earlyPress = await ps[1].emit('buzz');
  ok(!earlyPress.won, 'нажатие до активации не засчитано');
  // A player refreshes mid-countdown: the timer must not restart.
  const before = deadline();
  ps[2].close();
  const again = new Client();
  await again.ready();
  await again.emit('player:join', { token: players[2].token });
  again.id = players[2].id;
  ps[2] = again;
  again.socket.on('state', (v) => v.question?.buzzer.open && !opened.has(again.id) && opened.set(again.id, Date.now()));
  await sleep(100);
  ok(Math.abs(deadline() - before) < 150 && again.view.question && !again.view.question.buzzer.open, 'переподключение не перезапускает таймер, кнопка у вернувшегося закрыта');
  while (!host2.view.question.buzzer.open && Date.now() - tLong < dLong + 2000) await sleep(20);
  const elapsed = Date.now() - tLong;
  ok(host2.view.question.buzzer.open && Math.abs(elapsed - dLong) < 300, `кнопка открылась сама через ${elapsed} мс (план ${dLong})`);
  await sleep(100);
  const times = [...opened.values()];
  ok(times.length === ps.length && Math.max(...times) - Math.min(...times) < 100, `активация у всех ${times.length} игроков одновременно (разброс ${Math.max(...times) - Math.min(...times)} мс)`);
  const win = await Promise.all(ps.filter((c) => c !== ps[1]).map((c) => c.emit('buzz')));
  ok(win.filter((r) => r.won).length === 1, 'после активации арбитраж работает как прежде: один победитель');
  await done();

  // Image: random 3–7 s, generated once; pause freezes the countdown.
  await play(imageQ);
  await sleep(50);
  const dImg = host2.view.question.auto.delayMs;
  ok(host2.view.question.auto.media && dImg >= 3000 && dImg <= 7000, `картинка: случайная задержка ${dImg} мс`);
  await host2.host({ type: 'togglePause' });
  await sleep(50);
  const frozen = host2.view.question.auto.remainingMs;
  await sleep(dImg + 200);
  ok(host2.view.question.auto.mode === 'paused' && !host2.view.question.buzzer.open, `пауза замораживает отсчёт (осталось ${frozen} мс)`);
  await host2.host({ type: 'togglePause' });
  await sleep(50);
  ok(host2.view.question.auto.mode === 'counting' && Math.abs(host2.view.question.auto.remainingMs - frozen) < 200, 'после паузы отсчёт продолжается с того же места');
  ok(host2.view.question.auto.delayMs === dImg, 'задержка не меняется (сгенерирована один раз)');
  await done();

  // Audio: waits for actual playback start reported by the host.
  await play(audioQ);
  await sleep(500);
  ok(host2.view.question.auto.mode === 'waitingMedia' && !host2.view.question.buzzer.open, 'аудио: ждём начала воспроизведения');
  await host2.host({ type: 'mediaStarted' });
  await sleep(50);
  const dAud = host2.view.question.auto.delayMs;
  ok(host2.view.question.auto.mode === 'counting' && host2.view.question.auto.remainingMs > dAud - 200, `аудио: отсчёт ${dAud} мс пошёл с начала воспроизведения`);
  await host2.host({ type: 'setSettings', autoBuzzer: false });
  await sleep(dAud + 200);
  ok(host2.view.question.auto.mode === 'off' && !host2.view.question.buzzer.open, 'авто-кнопка выключена в настройках — не открылась');
  await host2.host({ type: 'setSettings', autoBuzzer: true });
  await sleep(50);
  ok(host2.view.question.auto.mode === 'counting', 'включили снова — отсчёт возобновился');
  await done();
  await host2.host({ type: 'setSettings', autoBuzzer: false });
  const anyLeft = all1.find((x) => !host2.view.board.themes[x.t].questions[x.q].used && x.pq.type === 'simple' && x !== audioQ);
  await play(anyLeft);
  await sleep(2000);
  ok(host2.view.question.auto.mode === 'off' && !host2.view.question.buzzer.open, 'при выключенной настройке новый вопрос без авто-открытия');
  await done();
  await host2.host({ type: 'setSettings', autoBuzzer: true });

  console.log('\n[Таймаут вопроса]  (TIMER_SCALE=0.2: 10 с → 2 с, возврат 4 с → 0,8 с)');
  await host2.host({ type: 'setRound', index: 2 });
  await sleep(50);
  const r2 = pkg.rounds[2];
  const pool = r2.themes
    .flatMap((t, ti) => t.questions.map((q, qi) => ({ t: ti, q: qi, pq: q })))
    .filter((x) => x.pq.type === 'simple' && x.pq.question.every((i) => i.kind === 'text'));
  let next = 0;
  const play2 = async () => {
    const x = pool[next++];
    await host2.host({ type: 'selectQuestion', theme: x.t, question: x.q });
    await sleep(50);
    return x;
  };
  const tq = () => host2.view.question;
  const scores = () => JSON.stringify(host2.view.players.map((p) => [p.id, p.score]));
  const waitFor = async (cond, ms) => {
    const t = Date.now();
    while (!cond() && Date.now() - t < ms) await sleep(20);
    return cond();
  };
  ok(!(await host2.host({ type: 'setSettings', timeoutSec: 7 })).ok, 'недопустимое время ответа отклонено');
  await host2.host({ type: 'setSettings', timeoutSec: 10 });

  // 1. Nobody answers.
  const u = await play2();
  ok(tq().timer === null, 'таймер не идёт, пока кнопка не активна');
  const before1 = scores();
  await host2.host({ type: 'openBuzzer' });
  await sleep(50);
  ok(ps.every((c) => c.view.question.timer?.running && c.view.question.timer.totalMs === 2000), 'таймер стартовал с активацией кнопки, виден всем игрокам');
  ok(await waitFor(() => tq()?.stage === 'answer', 2500), 'никто не нажал — вопрос закрылся сам');
  await sleep(50);
  ok(tq().unanswered && tq().timer.expired && tq().answered.length === 0, 'вопрос помечен как неотвеченный');
  ok(scores() === before1, 'очки никому не начислены и не списаны');
  ok(ps.every((c) => c.view.question.answer?.right?.length > 0 && c.view.question.returnMs > 0), 'игроки видят правильный ответ и отсчёт до возврата');
  ok(!(await host2.host({ type: 'timerReset' })).ok, 'после истечения таймер не перезапускается (нет повторного таймаута)');
  ok(await waitFor(() => host2.view.phase === 'board', 1500), 'автоматический возврат к табло');
  await sleep(50);
  ok(host2.view.board.themes[u.t].questions[u.q].used && ps.every((c) => c.view.phase === 'board'), 'вопрос отмечен сыгранным, все вернулись к табло');

  // 2. Wrong answer: timer pauses while answering, resumes with the remaining time.
  const w = await play2();
  await host2.host({ type: 'openBuzzer' });
  await sleep(700);
  const answerer = ps[0];
  const scoreA = answerer.view.me.score;
  ok((await answerer.emit('buzz')).won, 'игрок нажал кнопку');
  await sleep(50);
  const rem = tq().timer.remainingMs;
  ok(!tq().timer.running && rem > 1000 && rem < 1400, `таймер на паузе, пока игрок отвечает (осталось ${rem} мс)`);
  await sleep(rem + 400);
  ok(tq().stage === 'answering' && answerer.view.me.score === scoreA, 'пока игрок отвечает, время не истекает и ответ не засчитывается неверным автоматически');
  await host2.host({ type: 'judge', correct: false });
  await sleep(50);
  ok(answerer.view.me.score === scoreA - w.pq.price, `неверный ответ: −${w.pq.price} по обычным правилам`);
  ok(tq().buzzer.open && tq().timer.running && Math.abs(tq().timer.remainingMs - rem) < 150, `кнопка снова открыта для остальных, отсчёт продолжился с ${tq().timer.remainingMs} мс`);
  const before2 = scores();
  ok(!(await answerer.emit('buzz')).won, 'ответивший неверно не может нажать снова');
  ok(await waitFor(() => tq()?.stage === 'answer', rem + 500), 'никто больше не нажал — вопрос закрылся');
  ok(scores() === before2 && answerer.view.me.score === scoreA - w.pq.price, 'после таймаута дополнительных штрафов нет');
  ok(await waitFor(() => host2.view.phase === 'board', 1500), 'возврат к табло');

  // 3. Correct answer: no automatic timeout afterwards.
  await play2();
  await host2.host({ type: 'openBuzzer' });
  await sleep(100);
  await ps[1].emit('buzz');
  await host2.host({ type: 'judge', correct: true });
  await sleep(2300);
  ok(tq()?.stage === 'answer' && !tq().unanswered && tq().returnMs === undefined, 'верный ответ: вопрос завершён, таймаут не срабатывает');
  await host2.host({ type: 'finishQuestion' });

  // 4. Moderator pauses / resets the timer.
  await play2();
  await host2.host({ type: 'openBuzzer' });
  await sleep(500);
  await host2.host({ type: 'timerPause' });
  await sleep(30);
  const frozenT = tq().timer.remainingMs;
  ok(!tq().timer.running && tq().timer.paused && ps[0].view.question.timer.paused, `ведущий поставил таймер на паузу (${frozenT} мс)`);
  await sleep(2300);
  ok(tq().stage === 'content' && tq().timer.remainingMs === frozenT, 'на паузе время не идёт и вопрос не закрывается');
  await host2.host({ type: 'timerPause' });
  await sleep(30);
  ok(tq().timer.running && Math.abs(tq().timer.remainingMs - frozenT) < 100, 'таймер продолжился с того же места');
  await host2.host({ type: 'timerReset' });
  await sleep(30);
  ok(tq().timer.remainingMs > 1900, `сброс таймера: снова ${tq().timer.remainingMs} мс`);
  await host2.host({ type: 'skipQuestion' });
  await sleep(30);
  ok(tq()?.stage === 'answer' && !tq().unanswered && tq().returnMs > 0 && ps[0].view.question.answer, 'кнопка «Пропустить»: таймер отменён, ответ показан игрокам');
  ok(await waitFor(() => host2.view.phase === 'board', 1500), 'после пропуска — сам возврат к табло');

  // 5. Game pause freezes the timer and restores the open buzzer.
  await play2();
  await host2.host({ type: 'openBuzzer' });
  await sleep(500);
  await host2.host({ type: 'togglePause' });
  await sleep(30);
  const pausedRem = tq().timer.remainingMs;
  await sleep(2300);
  ok(tq().stage === 'content' && !tq().buzzer.open && tq().timer.remainingMs === pausedRem, 'пауза игры замораживает таймер');
  await host2.host({ type: 'togglePause' });
  await sleep(30);
  ok(tq().buzzer.open && tq().timer.running && Math.abs(tq().timer.remainingMs - pausedRem) < 100, 'после паузы кнопка и таймер восстановлены');

  // 6. Reconnect keeps the remaining time.
  await sleep(400);
  ps[3].close();
  const back = new Client();
  await back.ready();
  await back.emit('player:join', { token: players[3].token });
  back.id = players[3].id;
  ps[3] = back;
  await sleep(50);
  ok(Math.abs(back.view.question.timer.remainingMs - tq().timer.remainingMs) < 150, `вернувшийся игрок видит верный остаток (${back.view.question.timer.remainingMs} мс)`);
  ok(await waitFor(() => host2.view.phase === 'board' && back.view.phase === 'board', 3000), 'таймаут и возврат к табло после переподключения');

  // 7. Timeout disabled in settings.
  await host2.host({ type: 'setSettings', timeoutSec: 0 });
  await play2();
  await host2.host({ type: 'openBuzzer' });
  await sleep(2500);
  ok(tq().stage === 'content' && tq().buzzer.open && tq().timer === null, 'таймаут выключен — вопрос ждёт без ограничения');
  await host2.host({ type: 'skipQuestion' });
  await host2.host({ type: 'finishQuestion' });
  await host2.host({ type: 'setSettings', timeoutSec: 15 });

  console.log('\n[Финал]');
  const finalIdx = pkg.rounds.findIndex((r) => r.type === 'final');
  if (finalIdx >= 0) {
    await host2.host({ type: 'setRound', index: finalIdx });
    await sleep(50);
    ok(ps[0].view.phase === 'final', 'финал: выбор тем');
    await host2.host({ type: 'finalRemoveTheme', theme: 0 });
    await host2.host({ type: 'finalPlayTheme', theme: 1 });
    await sleep(50);
    ok(ps[0].view.question?.stage === 'stakes', 'финал: этап ставок');
    ok(ps[0].view.question.content === null, 'финал: вопрос скрыт до ставок');
    const rich = ps.find((c) => c.view.me.score > 0);
    const poor = ps.find((c) => c.view.me.score <= 0);
    ok(!(await rich.emit('player:stake', { amount: rich.view.me.score + 1 })).ok, 'ставка больше счёта отклонена');
    ok((await rich.emit('player:stake', { amount: rich.view.me.score })).ok, 'ва-банк принят');
    if (poor) ok(!(await poor.emit('player:stake', { amount: 5 })).ok, 'игрок без очков не может поставить больше 0');
    await host2.host({ type: 'closeStakes' });
    await sleep(50);
    ok(ps[0].view.question.content?.length > 0, 'финал: вопрос показан');
    await rich.emit('player:answer', { text: 'мой ответ' });
    await sleep(50);
    const other = ps.find((c) => c !== rich);
    ok(!JSON.stringify(other.view).includes('мой ответ'), 'чужие письменные ответы скрыты');
    ok(host2.view.question.written.find((w) => w.playerId === rich.id)?.text === 'мой ответ', 'ведущий видит ответ');
    await host2.host({ type: 'closeWritten' });
    const before = rich.view.me.score;
    await host2.host({ type: 'judgeWritten', playerId: rich.id, correct: true });
    await sleep(50);
    ok(rich.view.me.score === before * 2, `финал: верный ответ удваивает счёт (${before} → ${rich.view.me.score})`);
    await host2.host({ type: 'judgeWritten', playerId: rich.id, correct: false });
    await sleep(50);
    ok(rich.view.me.score === 0, 'вердикт можно изменить (пересчёт)');
    await host2.host({ type: 'revealAnswer' });
    await host2.host({ type: 'finishQuestion' });
    await sleep(50);
    ok(ps[0].view.phase === 'gameOver', 'игра завершена');
  }

  for (const c of [host2, ...ps]) c.close();
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    if (server && server.exitCode === null) await stopServer();
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(failures ? `\n✘ Ошибок: ${failures}` : '\n✔ Все проверки пройдены');
    process.exit(failures ? 1 : 0);
  });
