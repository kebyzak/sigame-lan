import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameView, HostAction, PackageSummary, PlayerView, QuestionViewData } from '../../shared/types';
import {
  Badge,
  Board,
  Button,
  ConnectionBadge,
  ContentItems,
  GameOver,
  JoinQr,
  RoundIntro,
  TYPE_LABELS,
  cx,
  playerName,
  QuestionTimer,
  roundTitle,
} from '../components/common';
import { QuestionDisplay } from '../components/QuestionDisplay';
import { emitAck, hostAction, useGameSocket } from '../socket';
import { unlockAudio } from '../sound';

const HOST_KEY = 'sigame.host.token';
const SOUND_KEY = 'sigame.host.sound';

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

async function claimToken(): Promise<string | null> {
  try {
    const r = await fetch('/api/host/claim');
    if (!r.ok) return null;
    const { token } = await r.json();
    ls.set(HOST_KEY, token);
    return token;
  } catch {
    return null;
  }
}

async function initialToken(): Promise<string | null> {
  const url = new URL(location.href);
  const key = url.searchParams.get('key');
  if (key) {
    ls.set(HOST_KEY, key);
    history.replaceState(null, '', url.pathname);
    return key;
  }
  return ls.get(HOST_KEY) ?? (await claimToken());
}

type Act = (a: HostAction) => Promise<boolean>;

export function HostPage() {
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [sound, setSound] = useState(ls.get(SOUND_KEY) !== '0');
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    initialToken().then((t) => {
      tokenRef.current = t;
      setToken(t);
      setChecked(true);
    });
  }, []);

  const { view, connected, socket } = useGameSocket(async (s: Socket) => {
    let r = await emitAck(s, 'host:auth', { token: tokenRef.current });
    if (!r.ok) {
      // Stored token may be stale (e.g. data folder was reset) — try to re-claim on localhost.
      const t = await claimToken();
      if (t) {
        tokenRef.current = t;
        setToken(t);
        r = await emitAck(s, 'host:auth', { token: t });
      }
    }
    setAuthError(r.ok ? '' : 'Ключ ведущего не подошёл. Откройте страницу ведущего на компьютере, где запущен сервер.');
  }, !!token);

  const act: Act = useCallback(
    async (a) => {
      const r = await hostAction(socket.current, a);
      if (!r.ok) {
        setError(r.error ?? 'Ошибка');
        setTimeout(() => setError(''), 3500);
      }
      return r.ok;
    },
    [socket],
  );

  if (checked && !token) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center p-6">
        <div className="glass max-w-lg rounded-3xl p-8 text-center">
          <div className="text-5xl">🔒</div>
          <div className="mt-4 text-2xl font-black">Нет доступа ведущего</div>
          <p className="mt-3 text-slate-300">
            Панель ведущего открывается на компьютере, где запущен сервер: <b>http://localhost:3000</b>. С другого устройства используйте
            ссылку с ключом из консоли сервера.
          </p>
          <a href="/" className="mt-6 inline-block text-violet-300 underline">
            Войти как игрок
          </a>
        </div>
      </div>
    );
  }
  if (authError) {
    return <div className="flex min-h-[100dvh] items-center justify-center p-6 text-center text-xl text-rose-200">{authError}</div>;
  }
  if (!view) return <div className="flex min-h-[100dvh] items-center justify-center text-xl text-slate-400">Подключение к серверу…</div>;

  const toggleSound = () => {
    setSound(!sound);
    ls.set(SOUND_KEY, sound ? '0' : '1');
  };

  return (
    <>
      <ConnectionBadge connected={connected} />
      <RoundIntro view={view} />
      {view.phase === 'lobby' ? (
        <Lobby view={view} act={act} token={token!} />
      ) : (
        <Dashboard view={view} act={act} sound={sound} toggleSound={toggleSound} />
      )}
      {error && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-rose-600 px-5 py-3 font-semibold text-white shadow-2xl fade-in">{error}</div>
      )}
    </>
  );
}

// ---------------- Lobby ----------------

function Lobby({ view, act, token }: { view: GameView; act: Act; token: string }) {
  const [summary, setSummary] = useState<PackageSummary | null>(null);
  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="bg-gradient-to-r from-blue-400 to-fuchsia-400 bg-clip-text text-4xl font-black text-transparent">СИ-Игра</div>
          <div className="text-slate-400">Панель ведущего</div>
        </div>
        <a href="/screen" target="_blank" rel="noreferrer" className="rounded-xl bg-white/5 px-4 py-2 text-sm text-slate-200 hover:bg-white/10">
          📺 Открыть экран для ТВ
        </a>
      </header>
      <div className="grid flex-1 gap-6 lg:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-6">
          <section className="glass rounded-3xl p-6">
            <h2 className="mb-4 text-xl font-black">1. Пакет вопросов</h2>
            <PackageUpload token={token} onDone={setSummary} />
            {view.pkg && (
              <div className="mt-5 flex gap-4 rounded-2xl bg-white/5 p-4 pop-in">
                {view.pkg.logoUrl && <img src={view.pkg.logoUrl} alt="" className="h-20 w-20 rounded-xl object-cover" />}
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-black">{view.pkg.name}</div>
                  {view.pkg.author && <div className="text-sm text-slate-400">Автор: {view.pkg.author}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {view.pkg.rounds.map((r, i) => {
                      const s = summary?.id === view.pkg!.id ? summary.rounds[i] : undefined;
                      return (
                        <Badge key={i} className={r.type === 'final' ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'bg-blue-500/20 text-blue-200'}>
                          {r.name}
                          {s ? ` · ${s.themes} тем · ${s.questions} вопр.` : ''}
                        </Badge>
                      );
                    })}
                  </div>
                  {summary && <div className="mt-2 text-sm text-slate-400">Медиафайлов: {summary.mediaCount}</div>}
                  {summary && summary.warnings.length > 0 && (
                    <details className="mt-2 text-sm text-amber-200">
                      <summary className="cursor-pointer">Предупреждения ({summary.warnings.length})</summary>
                      <ul className="mt-1 list-disc pl-5">
                        {summary.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            )}
          </section>
          <section className="glass rounded-3xl p-6">
            <h2 className="mb-4 text-xl font-black">3. Начать</h2>
            <Button size="lg" className="w-full" disabled={!view.pkg} onClick={() => act({ type: 'startGame' })}>
              {view.pkg ? `Начать игру (${view.players.length} игр.)` : 'Сначала загрузите пакет'}
            </Button>
          </section>
        </div>
        <section className="glass flex flex-col gap-5 rounded-3xl p-6">
          <h2 className="text-xl font-black">2. Подключение игроков</h2>
          <div className="text-sm text-slate-400">Отсканируйте QR-код телефоном (в той же сети Wi-Fi) или откройте адрес в браузере.</div>
          <JoinQr />
          <PlayersPanel view={view} act={act} />
        </section>
      </div>
    </div>
  );
}

function PackageUpload({ token, onDone }: { token: string; onDone: (s: PackageSummary) => void }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = (file: File) => {
    if (!/\.siq$/i.test(file.name) && !confirm('Файл не похож на .siq. Всё равно загрузить?')) return;
    setError('');
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/host/upload');
    xhr.setRequestHeader('x-host-token', token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(e.loaded / e.total);
      if (e.loaded === e.total) setProcessing(true);
    };
    xhr.onload = () => {
      setProgress(null);
      setProcessing(false);
      let body: any = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status === 200) onDone(body);
      else setError(body.error ?? `Ошибка загрузки (${xhr.status})`);
    };
    xhr.onerror = () => {
      setProgress(null);
      setProcessing(false);
      setError('Сетевая ошибка при загрузке');
    };
    xhr.send(file);
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        }}
        onClick={() => progress === null && inputRef.current?.click()}
        className={cx(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition',
          drag ? 'border-violet-400 bg-violet-500/10' : 'border-white/15 hover:border-violet-400/60 hover:bg-white/5',
        )}
      >
        <div className="text-4xl">📦</div>
        {progress === null ? (
          <>
            <div className="text-lg font-semibold">Перетащите файл .siq сюда или нажмите для выбора</div>
            <div className="text-sm text-slate-400">Пакеты из SIGame / SIQuester (форматы v4 и v5)</div>
          </>
        ) : (
          <div className="w-full max-w-sm">
            <div className="mb-2 font-semibold">{processing ? 'Обработка пакета…' : `Загрузка… ${Math.round(progress * 100)}%`}</div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-gradient-to-r from-blue-500 to-fuchsia-500 transition-all" style={{ width: `${(processing ? 1 : progress) * 100}%` }} />
            </div>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".siq,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="mt-3 rounded-xl bg-rose-500/15 px-4 py-2 text-rose-200">{error}</div>}
    </div>
  );
}

// ---------------- Players ----------------

function PlayersPanel({ view, act, step = 100 }: { view: GameView; act: Act; step?: number }) {
  const q = view.question;
  const canSetAnswering = view.phase === 'question' && q && (q.stage === 'content' || q.stage === 'answering') && !q.written;
  const answeringId = q?.buzzer.winnerId ?? (q?.stage === 'content' ? q?.responderId : null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="font-bold">Игроки ({view.players.length})</div>
        <div className="text-xs text-slate-500">шаг ±{step}</div>
      </div>
      {view.players.length === 0 && <div className="rounded-xl bg-white/5 py-6 text-center text-slate-400">Ждём игроков…</div>}
      {view.players.map((p) => (
        <PlayerRow
          key={p.id}
          p={p}
          view={view}
          act={act}
          step={step}
          answering={p.id === answeringId}
          canSetAnswering={!!canSetAnswering}
        />
      ))}
    </div>
  );
}

function PlayerRow({
  p,
  view,
  act,
  step,
  answering,
  canSetAnswering,
}: {
  p: PlayerView;
  view: GameView;
  act: Act;
  step: number;
  answering: boolean;
  canSetAnswering: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(p.score));
  const chooser = view.chooserId === p.id;
  const blocked = view.question?.buzzer.blocked.includes(p.id);
  return (
    <div
      className={cx(
        'rounded-2xl px-3 py-2 transition',
        answering ? 'bg-emerald-500/20 ring-1 ring-emerald-400' : 'bg-white/5',
        !p.online && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', p.online ? 'bg-emerald-400' : 'bg-slate-600')} title={p.online ? 'В сети' : 'Не в сети'} />
        <span className="min-w-0 flex-1 truncate font-semibold">
          {p.name}
          {blocked && <span className="ml-1 text-xs text-rose-300">(ответил)</span>}
        </span>
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act({ type: 'setScore', playerId: p.id, score: Number(value) });
              setEditing(false);
            }}
          >
            <input
              autoFocus
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setEditing(false)}
              className="w-24 rounded-lg bg-navy-900 px-2 py-1 text-right font-bold outline-none ring-1 ring-violet-400"
            />
          </form>
        ) : (
          <button
            onClick={() => {
              setValue(String(p.score));
              setEditing(true);
            }}
            title="Изменить счёт"
            className={cx('rounded-lg px-2 py-0.5 text-xl font-black tabular-nums hover:bg-white/10', p.score < 0 ? 'text-rose-300' : 'text-amber-200')}
          >
            {p.score}
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => act({ type: 'adjustScore', playerId: p.id, delta: -step })}>
          −{step}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => act({ type: 'adjustScore', playerId: p.id, delta: step })}>
          +{step}
        </Button>
        <button
          onClick={() => act({ type: 'setChooser', playerId: chooser ? null : p.id })}
          className={cx('rounded-lg px-2 py-1 text-sm', chooser ? 'bg-amber-400/20' : 'opacity-40 hover:opacity-100')}
          title="Выбирает вопрос"
        >
          👑
        </button>
        {canSetAnswering && (
          <button onClick={() => act({ type: 'setAnswering', playerId: p.id })} className="rounded-lg px-2 py-1 text-sm hover:bg-white/10" title="Назначить отвечающим">
            🎤
          </button>
        )}
        <span className="flex-1" />
        <button
          onClick={() => confirm(`Удалить игрока «${p.name}»?`) && act({ type: 'kickPlayer', playerId: p.id })}
          className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-rose-500/20 hover:text-rose-200"
          title="Удалить игрока"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ---------------- Dashboard ----------------

function Dashboard({ view, act, sound, toggleSound }: { view: GameView; act: Act; sound: boolean; toggleSound: () => void }) {
  const [showQr, setShowQr] = useState(false);
  const rounds = view.pkg?.rounds ?? [];
  const q = view.question;
  const step = q && q.price > 0 ? q.price : 100;

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-navy-950/60 px-5 py-3 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate text-lg font-black">{view.pkg?.name}</div>
          <div className="text-xs text-slate-400">Панель ведущего</div>
        </div>
        <select
          value={view.roundIndex}
          onChange={(e) => {
            const i = Number(e.target.value);
            if (confirm(`Перейти к раунду «${rounds[i]?.name}»?`)) act({ type: 'setRound', index: i });
          }}
          className="rounded-xl border border-white/10 bg-navy-800 px-3 py-2 font-semibold"
        >
          {rounds.map((r, i) => (
            <option key={i} value={i}>
              {r.type === 'final' ? '🏁 ' : ''}{roundTitle(r.name)}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <Button
          variant={view.settings?.autoBuzzer ? 'ghost' : 'subtle'}
          size="sm"
          title="Автоматически открывать кнопку после показа вопроса"
          onClick={() => act({ type: 'setSettings', autoBuzzer: !view.settings?.autoBuzzer })}
        >
          {view.settings?.autoBuzzer ? '⚡ Авто-кнопка: вкл' : '✋ Авто-кнопка: выкл'}
        </Button>
        <select
          value={view.settings?.timeoutSec ?? 15}
          onChange={(e) => act({ type: 'setSettings', timeoutSec: Number(e.target.value) })}
          title="Время на ответ: если никто не нажал кнопку, вопрос закрывается автоматически"
          className="rounded-lg border border-white/10 bg-navy-800 px-2 py-1 text-sm font-semibold"
        >
          {[10, 15, 20, 30].map((v) => (
            <option key={v} value={v}>
              ⏱ {v} с на ответ
            </option>
          ))}
          <option value={0}>⏱ Без таймаута</option>
        </select>
        <Button variant="ghost" size="sm" onClick={toggleSound}>
          {sound ? '🔊 Звук' : '🔇 Без звука'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShowQr(!showQr)}>
          📱 QR
        </Button>
        <a href="/screen" target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-sm font-semibold hover:bg-white/10">
          📺 Экран
        </a>
        <Button variant={view.paused ? 'success' : 'ghost'} size="sm" onClick={() => act({ type: 'togglePause' })}>
          {view.paused ? '▶ Продолжить' : '⏸ Пауза'}
        </Button>
        {view.phase === 'gameOver' ? (
          <Button size="sm" onClick={() => confirm('Начать новую игру? Счёт будет обнулён.') && act({ type: 'resetGame' })}>
            Новая игра
          </Button>
        ) : (
          <Button variant="danger" size="sm" onClick={() => confirm('Завершить игру и показать итоги?') && act({ type: 'endGame' })}>
            Завершить
          </Button>
        )}
      </header>

      {showQr && (
        <div className="fixed right-5 top-20 z-40 glass rounded-3xl p-5 shadow-2xl pop-in">
          <JoinQr size="sm" />
        </div>
      )}

      <div className="grid flex-1 gap-5 p-5 xl:grid-cols-[1fr_360px]">
        <main className="flex min-w-0 flex-col gap-4">
          {view.paused && <div className="rounded-2xl bg-amber-500/15 px-4 py-2 text-center font-semibold text-amber-200">Игра на паузе — игроки видят экран паузы, кнопка отключена</div>}
          {view.phase === 'board' && view.board && <BoardPanel view={view} act={act} />}
          {view.phase === 'final' && view.final && <FinalPanel view={view} act={act} />}
          {view.phase === 'question' && q && <HostQuestion view={view} q={q} act={act} sound={sound} />}
          {view.phase === 'gameOver' && (
            <div className="glass rounded-3xl p-6">
              <GameOver players={view.players} />
            </div>
          )}
        </main>
        <aside className="flex flex-col gap-4">
          {q && <BuzzerPanel view={view} q={q} act={act} />}
          <div className="glass rounded-3xl p-4">
            <PlayersPanel view={view} act={act} step={step} />
          </div>
          <div className="px-2 text-xs leading-relaxed text-slate-500">
            Клавиши: <b>Пробел</b> — открыть/закрыть кнопку, <b>Y</b> — верно, <b>N</b> — неверно, <b>A</b> — показать ответ, <b>S</b> — пропустить, <b>→</b> — к табло.
          </div>
        </aside>
      </div>
    </div>
  );
}

function BoardPanel({ view, act }: { view: GameView; act: Act }) {
  const board = view.board!;
  const rounds = view.pkg?.rounds ?? [];
  const hasNext = view.roundIndex + 1 < rounds.length;
  return (
    <div className="flex flex-col gap-4 fade-in">
      <div className="flex items-center justify-between">
        <div className="text-2xl font-black">{roundTitle(board.name)}</div>
        <div className="text-slate-400">
          {view.chooserId ? (
            <>
              Выбирает: <b className="text-amber-200">{playerName(view, view.chooserId)}</b> ·{' '}
            </>
          ) : null}
          осталось вопросов: {board.remaining}
        </div>
      </div>
      <Board board={board} onSelect={(t, q) => act({ type: 'selectQuestion', theme: t, question: q })} />
      {board.remaining === 0 && (
        <div className="glass flex items-center justify-between rounded-2xl p-4 pop-in">
          <div className="text-lg font-semibold">Раунд сыгран!</div>
          {hasNext ? (
            <Button size="lg" onClick={() => act({ type: 'setRound', index: view.roundIndex + 1 })}>
              Следующий раунд: {rounds[view.roundIndex + 1].name} →
            </Button>
          ) : (
            <Button size="lg" onClick={() => act({ type: 'endGame' })}>
              Подвести итоги
            </Button>
          )}
        </div>
      )}
      {board.remaining > 0 && hasNext && (
        <div className="text-right">
          <Button variant="subtle" size="sm" onClick={() => confirm('Закончить раунд досрочно?') && act({ type: 'setRound', index: view.roundIndex + 1 })}>
            Пропустить оставшиеся вопросы раунда →
          </Button>
        </div>
      )}
    </div>
  );
}

function FinalPanel({ view, act }: { view: GameView; act: Act }) {
  const themes = view.final!.themes;
  const left = themes.filter((t) => !t.removed).length;
  return (
    <div className="flex flex-col gap-4 fade-in">
      <div className="text-3xl font-black">Финал</div>
      <div className="text-slate-400">
        Игроки по очереди убирают темы (называют вам), вы отмечаете их здесь. Можно сразу выбрать тему для игры.
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {themes.map((t, i) => (
          <div key={i} className={cx('flex items-center gap-3 rounded-2xl px-4 py-3', t.removed ? 'bg-white/5' : 'tile')}>
            <span className={cx('flex-1 text-lg font-bold', t.removed && 'text-slate-500 line-through')}>{t.name}</span>
            <Button size="sm" variant="ghost" onClick={() => act({ type: 'finalRemoveTheme', theme: i })}>
              {t.removed ? 'Вернуть' : 'Убрать'}
            </Button>
            {!t.removed && (
              <Button size="sm" variant={left === 1 ? 'success' : 'ghost'} onClick={() => act({ type: 'finalPlayTheme', theme: i })}>
                Играть ▶
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BuzzerPanel({ view, q, act }: { view: GameView; q: QuestionViewData; act: Act }) {
  if (q.written || q.responderId || q.stage === 'intro') return null;
  const b = q.buzzer;
  return (
    <div
      className={cx(
        'rounded-3xl p-4 transition',
        b.open ? 'bg-fuchsia-600/25 ring-2 ring-fuchsia-400' : b.winnerId ? 'bg-emerald-500/20 ring-2 ring-emerald-400' : 'glass',
      )}
    >
      <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Кнопка</div>
      <div className="mt-1 text-2xl font-black">
        {b.open ? 'Открыта — ждём…' : b.winnerId ? `🔔 ${playerName(view, b.winnerId)}` : 'Закрыта'}
      </div>
      {!b.open && !b.winnerId && q.stage === 'content' && q.auto && <AutoStatus auto={q.auto} />}
      {q.timer && (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <QuestionTimer timer={q.timer} size="lg" sound />
          </div>
          {!q.timer.expired && q.stage !== 'answer' && (
            <>
              <Button size="sm" variant="ghost" title="Пауза / продолжить таймер" onClick={() => act({ type: 'timerPause' })}>
                {q.timer.paused && !view.paused ? '▶' : '⏸'}
              </Button>
              <Button size="sm" variant="ghost" title="Сбросить таймер" onClick={() => act({ type: 'timerReset' })}>
                ↺
              </Button>
            </>
          )}
        </div>
      )}
      {b.order.length > 0 && (
        <ol className="mt-2 space-y-0.5 text-sm">
          {b.order.map((o, i) => (
            <li key={o.playerId} className={i === 0 ? 'font-bold text-emerald-200' : 'text-slate-300'}>
              {i + 1}. {playerName(view, o.playerId)} — {i === 0 ? `${o.ms} мс` : `+${o.ms - b.order[0].ms} мс`}
            </li>
          ))}
        </ol>
      )}
      {b.falseStarts.length > 0 && (
        <div className="mt-2 text-xs text-rose-300">Фальстарт: {b.falseStarts.map((id) => playerName(view, id)).join(', ')}</div>
      )}
      {b.blocked.length > 0 && <div className="mt-2 text-xs text-slate-400">Уже отвечали: {b.blocked.map((id) => playerName(view, id)).join(', ')}</div>}
    </div>
  );
}

// ---------------- Question ----------------

function HostQuestion({ view, q, act, sound }: { view: GameView; q: QuestionViewData; act: Act; sound: boolean }) {
  useHostHotkeys(view, q, act);
  return (
    <div className="flex flex-col gap-4">
      <div className="glass flex min-h-[40vh] flex-col items-center justify-center rounded-3xl p-6">
        <QuestionDisplay view={view} q={q} sound={sound} onMediaStart={() => q.auto?.mode === 'waitingMedia' && act({ type: 'mediaStarted' })} />
      </div>
      <div className="glass rounded-3xl p-4">
        <HostControls view={view} q={q} act={act} />
      </div>
      {q.stage !== 'answer' && q.answer && <HostAnswerBox q={q} />}
    </div>
  );
}

function HostAnswerBox({ q }: { q: QuestionViewData }) {
  const a = q.answer!;
  const opt = a.correctOption ? q.options?.find((o) => o.label === a.correctOption) : null;
  return (
    <div className="rounded-3xl border border-emerald-400/30 bg-emerald-500/10 p-4">
      <div className="text-xs font-bold uppercase tracking-widest text-emerald-300">Ответ — видите только вы</div>
      <div className="mt-1 text-2xl font-black text-emerald-100">
        {opt ? `${a.correctOption}: ${opt.content.map((c) => c.text).join(' ')}` : a.right.join(' / ') || '—'}
      </div>
      {a.wrong.length > 0 && <div className="mt-1 text-sm text-rose-200">Не принимается: {a.wrong.join('; ')}</div>}
      {q.comment && <div className="mt-1 text-sm text-slate-300">💬 {q.comment}</div>}
      {a.content.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-slate-300">Медиа ответа (предпросмотр)</summary>
          <div className="mt-2">
            <ContentItems items={a.content} sound autoPlay={false} compact />
          </div>
        </details>
      )}
    </div>
  );
}

function useHostHotkeys(view: GameView, q: QuestionViewData, act: Act) {
  const ref = useRef({ view, q, act });
  ref.current = { view, q, act };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const { q, act } = ref.current;
      const simple = !q.written && !q.responderId;
      if (e.code === 'Space' && simple && (q.stage === 'content' || q.stage === 'answering')) {
        e.preventDefault();
        act({ type: q.buzzer.open ? 'closeBuzzer' : 'openBuzzer' });
      } else if (e.code === 'KeyY' && (q.stage === 'answering' || (q.responderId && q.stage === 'content'))) {
        act({ type: 'judge', correct: true });
      } else if (e.code === 'KeyN' && (q.stage === 'answering' || (q.responderId && q.stage === 'content'))) {
        act({ type: 'judge', correct: false });
      } else if (e.code === 'KeyS' && q.stage !== 'answer') {
        act({ type: 'skipQuestion' });
      } else if (e.code === 'KeyA' && ['content', 'answering', 'review'].includes(q.stage)) {
        act({ type: 'revealAnswer' });
      } else if (e.code === 'ArrowRight' && q.stage === 'answer') {
        act({ type: 'finishQuestion' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function HostControls({ view, q, act }: { view: GameView; q: QuestionViewData; act: Act }) {
  const secondary = (
    <div className="flex flex-wrap gap-2">
      {q.stage !== 'answer' && q.stage !== 'intro' && q.stage !== 'stakes' && (
        <Button variant="ghost" onClick={() => act({ type: 'revealAnswer' })}>
          👁 Показать ответ
        </Button>
      )}
      {q.stage !== 'answer' && (
        <Button variant="ghost" title="Показать ответ и вернуться к табло (S)" onClick={() => act({ type: 'skipQuestion' })}>
          ⏭ Пропустить
        </Button>
      )}
      {q.answered.length === 0 && q.stage !== 'answer' && (
        <Button variant="subtle" onClick={() => act({ type: 'cancelQuestion' })}>
          ↩ Вернуть на табло
        </Button>
      )}
    </div>
  );

  if (q.stage === 'intro') return <AssignPanel view={view} q={q} act={act} />;

  if (q.stage === 'stakes') {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-lg font-bold">Ставки игроков</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {q.written?.map((w) => (
            <div key={w.playerId} className="flex justify-between rounded-xl bg-white/5 px-3 py-2">
              <span>{playerName(view, w.playerId)}</span>
              <span className={w.stakeSubmitted ? 'font-bold text-amber-200' : 'text-slate-500'}>{w.stakeSubmitted ? w.stake : 'ждём…'}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={() => act({ type: 'closeStakes' })}>
            Принять ставки и показать вопрос
          </Button>
          {secondary}
        </div>
        <div className="text-xs text-slate-500">Не сделавшим ставку будет засчитана ставка 1 (или 0 при неположительном счёте).</div>
      </div>
    );
  }

  if (q.stage === 'answer') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={() => act({ type: 'finishQuestion' })}>
            {view.board?.type === 'final' ? 'Завершить финал →' : 'К табло →'}
          </Button>
          {q.answered.map((a, i) => (
            <Badge key={i} className={a.correct ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'}>
              {playerName(view, a.playerId)} {a.delta > 0 ? '+' : ''}
              {a.delta}
            </Badge>
          ))}
        </div>
        {q.written && <WrittenReview view={view} q={q} act={act} />}
      </div>
    );
  }

  // Written answers (forAll / final).
  if (q.written) {
    if (q.stage === 'content') {
      const done = q.written.filter((w) => w.submitted).length;
      return (
        <div className="flex flex-col gap-3">
          <div className="text-lg font-bold">
            Ответили: {done} из {q.written.length}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {q.written.map((w) => (
              <div key={w.playerId} className="rounded-xl bg-white/5 px-3 py-2">
                <div className="flex justify-between text-sm text-slate-400">
                  <span>{playerName(view, w.playerId)}</span>
                  {w.stake !== undefined && <span>ставка {w.stake}</span>}
                </div>
                <div className={w.submitted ? 'font-semibold' : 'text-slate-500'}>{w.text ?? 'пишет…'}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => act({ type: 'closeWritten' })}>
              Закрыть приём ответов
            </Button>
            {secondary}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <div className="text-lg font-bold">Проверьте ответы</div>
        <WrittenReview view={view} q={q} act={act} />
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={() => act({ type: 'revealAnswer' })}>
            Показать правильный ответ всем
          </Button>
          {secondary}
        </div>
      </div>
    );
  }

  // Responder questions (cat in bag, auction, no-risk).
  if (q.responderId) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-lg">
          Отвечает <b className="text-emerald-200">{playerName(view, q.responderId)}</b> за <b>{q.price}</b>
          {q.type === 'noRisk' && ' (без риска)'}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="success" size="lg" onClick={() => act({ type: 'judge', correct: true })}>
            ✓ Верно (+{q.price})
          </Button>
          <Button variant="danger" size="lg" onClick={() => act({ type: 'judge', correct: false })}>
            ✗ Неверно ({q.type === 'noRisk' ? '0' : `−${q.price}`})
          </Button>
          {secondary}
        </div>
      </div>
    );
  }

  // Classic buzzer question.
  const b = q.buzzer;
  if (q.stage === 'answering' && b.winnerId) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-lg">
          Отвечает <b className="text-2xl text-emerald-200">{playerName(view, b.winnerId)}</b>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="success" size="lg" onClick={() => act({ type: 'judge', correct: true })}>
            ✓ Верно (+{q.price})
          </Button>
          <Button variant="danger" size="lg" onClick={() => act({ type: 'judge', correct: false })}>
            ✗ Неверно (−{q.price})
          </Button>
          <Button variant="ghost" onClick={() => act({ type: 'openBuzzer' })}>
            🔄 Сбросить кнопку
          </Button>
          {secondary}
        </div>
      </div>
    );
  }
  const everyoneTried = view.players.length > 0 && view.players.every((p) => b.blocked.includes(p.id));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {b.open ? (
          <Button size="lg" variant="ghost" onClick={() => act({ type: 'closeBuzzer' })}>
            ⏹ Закрыть кнопку
          </Button>
        ) : (
          <Button size="lg" disabled={everyoneTried} onClick={() => act({ type: 'openBuzzer' })}>
            {b.blocked.length ? '🔔 Открыть кнопку снова' : '🔔 Открыть кнопку'}
          </Button>
        )}
        {secondary}
      </div>
      {everyoneTried && <div className="text-sm text-slate-400">Все игроки уже ответили — покажите ответ.</div>}
    </div>
  );
}

function WrittenReview({ view, q, act }: { view: GameView; q: QuestionViewData; act: Act }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {q.written!.map((w) => (
        <div key={w.playerId} className={cx('flex items-center gap-2 rounded-xl px-3 py-2', w.verdict === true ? 'bg-emerald-500/15' : w.verdict === false ? 'bg-rose-500/15' : 'bg-white/5')}>
          <div className="min-w-0 flex-1">
            <div className="flex justify-between text-sm text-slate-400">
              <span>{playerName(view, w.playerId)}</span>
              {w.stake !== undefined && <span>ставка {w.stake}</span>}
            </div>
            <div className="font-semibold">{w.text ?? '— нет ответа —'}</div>
          </div>
          <Button size="sm" variant={w.verdict === true ? 'success' : 'ghost'} onClick={() => act({ type: 'judgeWritten', playerId: w.playerId, correct: true })}>
            ✓
          </Button>
          <Button size="sm" variant={w.verdict === false ? 'danger' : 'ghost'} onClick={() => act({ type: 'judgeWritten', playerId: w.playerId, correct: false })}>
            ✗
          </Button>
        </div>
      ))}
    </div>
  );
}

function AssignPanel({ view, q, act }: { view: GameView; q: QuestionViewData; act: Act }) {
  const [playerId, setPlayerId] = useState<string | null>(view.chooserId);
  const prices = q.secretPrices ?? [];
  const defaultPrice = q.type === 'noRisk' ? q.price * 2 : prices.length > 0 ? prices[0] : q.price;
  const [price, setPrice] = useState(String(defaultPrice));
  const selected = view.players.find((p) => p.id === playerId);
  const hint =
    q.type === 'stake'
      ? 'Проведите аукцион голосом, затем укажите победителя и его ставку.'
      : q.type === 'noRisk'
        ? 'Вопрос без риска: отвечает выбравший, за ошибку очки не снимаются.'
        : q.type === 'secretNoQuestion'
          ? 'Игрок, получивший кота, сразу получает очки.'
          : 'Выбравший игрок передаёт вопрос — укажите, кому.';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Badge>{TYPE_LABELS[q.type]}</Badge>
        <span className="text-slate-300">{hint}</span>
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-slate-400">Игрок</div>
        <div className="flex flex-wrap gap-2">
          {view.players.map((p) => (
            <button
              key={p.id}
              onClick={() => setPlayerId(p.id)}
              className={cx('rounded-xl px-3 py-2 font-semibold transition', p.id === playerId ? 'bg-violet-600 text-white' : 'bg-white/5 hover:bg-white/10')}
            >
              {p.name} <span className="text-amber-200">{p.score}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-slate-400">{q.type === 'stake' ? 'Ставка' : 'Стоимость'}</div>
        <div className="flex flex-wrap items-center gap-2">
          {prices.length > 1 &&
            prices.map((v) => (
              <button
                key={v}
                onClick={() => setPrice(String(v))}
                className={cx('rounded-xl px-3 py-2 font-bold', String(v) === price ? 'bg-amber-400 text-navy-950' : 'bg-white/5 hover:bg-white/10')}
              >
                {v}
              </button>
            ))}
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="w-32 rounded-xl border border-white/10 bg-navy-900 px-3 py-2 font-bold outline-none focus:border-violet-400"
          />
          {q.type === 'stake' && selected && selected.score > 0 && (
            <Button variant="danger" size="sm" onClick={() => setPrice(String(selected.score))}>
              Ва-банк ({selected.score})
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" disabled={!playerId} onClick={() => playerId && act({ type: 'assignResponder', playerId, price: Number(price) })}>
          Назначить и показать вопрос
        </Button>
        <Button variant="ghost" onClick={() => act({ type: 'skipQuestion' })}>
          ⏭ Пропустить
        </Button>
        <Button variant="subtle" onClick={() => act({ type: 'cancelQuestion' })}>
          ↩ Вернуть на табло
        </Button>
      </div>
    </div>
  );
}

function AutoStatus({ auto }: { auto: NonNullable<QuestionViewData['auto']> }) {
  // Local countdown from the server's remaining time (host only; players never see it).
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    setDeadline(auto.mode === 'counting' ? Date.now() + (auto.remainingMs ?? 0) : 0);
  }, [auto.mode, auto.remainingMs]);
  useEffect(() => {
    if (auto.mode !== 'counting') return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [auto.mode]);
  const kind = auto.media ? 'медиа, случайно' : 'по длине текста';
  const text =
    auto.mode === 'counting'
      ? `⚡ Откроется через ${(Math.max(0, deadline - now) / 1000).toFixed(1)} с`
      : auto.mode === 'waitingMedia'
        ? '⏳ Ждём начала воспроизведения…'
        : auto.mode === 'paused'
          ? `⏸ Авто-кнопка на паузе (${((auto.remainingMs ?? 0) / 1000).toFixed(1)} с)`
          : auto.mode === 'off'
            ? '✋ Авто-кнопка выключена — откройте вручную'
            : null;
  if (!text) return null;
  return (
    <div className="mt-1 text-sm text-violet-200">
      {text}
      <div className="text-xs text-slate-500">
        задержка {(auto.delayMs / 1000).toFixed(1)} с ({kind}) · Пробел — открыть сразу
      </div>
    </div>
  );
}
