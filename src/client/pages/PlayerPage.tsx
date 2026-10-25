import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameView, QuestionViewData } from '../../shared/types';
import {
  Board,
  Button,
  ConnectionBadge,
  GameOver,
  Leaderboard,
  PauseOverlay,
  RoundIntro,
  cx,
  playerName,
  QuestionTimer,
  roundTitle,
} from '../components/common';
import { QuestionDisplay } from '../components/QuestionDisplay';
import { emitAck, useGameSocket } from '../socket';
import { activationBeep, timeoutSound, unlockAudio } from '../sound';

const TOKEN_KEY = 'sigame.player.token';

const SOUND_KEY = 'sigame.player.sound';

const store = {
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
      /* private mode */
    }
  },
};

export function PlayerPage() {
  const [joined, setJoined] = useState(false);
  const [hasToken, setHasToken] = useState(!!store.get(TOKEN_KEY));
  const [notice, setNotice] = useState('');
  const [sound, setSound] = useState(store.get(SOUND_KEY) === '1');

  const { view, setView, connected, socket } = useGameSocket(async (s: Socket) => {
    s.off('kicked').on('kicked', () => {
      store.set(TOKEN_KEY, null);
      setHasToken(false);
      setJoined(false);
      setView(null);
      setNotice('Ведущий удалил вас из игры');
    });
    const token = store.get(TOKEN_KEY);
    if (!token) return;
    const r = await emitAck<{ ok: boolean; error?: string }>(s, 'player:join', { token });
    if (r.ok) {
      setJoined(true);
    } else if (r.error === 'unknown-token') {
      store.set(TOKEN_KEY, null);
      setHasToken(false);
      setJoined(false);
      setView(null);
    }
  });

  const join = async (name: string) => {
    const r = await emitAck<{ ok: boolean; error?: string; token?: string }>(socket.current, 'player:join', { name });
    if (!r.ok || !r.token) return r.error ?? 'Не удалось войти';
    store.set(TOKEN_KEY, r.token);
    setHasToken(true);
    setJoined(true);
    setNotice('');
    return null;
  };

  const leave = async () => {
    if (!confirm('Выйти из игры? Ваши очки останутся у ведущего, но войти под этим именем снова не получится.')) return;
    await emitAck(socket.current, 'player:leave');
    store.set(TOKEN_KEY, null);
    setHasToken(false);
    setJoined(false);
    setView(null);
  };

  if (!joined || !view || !view.me) {
    if (hasToken && (!connected || !joined)) {
      return (
        <Centered>
          <div className="text-xl text-slate-300">Подключение к игре…</div>
        </Centered>
      );
    }
    return <JoinForm onJoin={join} connected={connected} notice={notice} />;
  }

  return (
    <PlayerGame
      view={view}
      socket={socket.current}
      connected={connected}
      sound={sound}
      onToggleSound={() => {
        setSound(!sound);
        store.set(SOUND_KEY, sound ? '0' : '1');
      }}
      onLeave={leave}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-6 p-6">{children}</div>;
}

function JoinForm({ onJoin, connected, notice }: { onJoin: (name: string) => Promise<string | null>; connected: boolean; notice: string }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Centered>
      <div className="text-center">
        <div className="bg-gradient-to-r from-blue-400 to-fuchsia-400 bg-clip-text text-5xl font-black text-transparent">СИ-Игра</div>
        <div className="mt-2 text-slate-400">Своя игра в локальной сети</div>
      </div>
      <form
        className="glass flex w-full max-w-sm flex-col gap-4 rounded-3xl p-6 pop-in"
        onSubmit={async (e) => {
          e.preventDefault();
          unlockAudio();
          setBusy(true);
          setError((await onJoin(name)) ?? '');
          setBusy(false);
        }}
      >
        {notice && <div className="rounded-xl bg-amber-500/15 px-3 py-2 text-amber-200">{notice}</div>}
        <label className="text-sm font-semibold text-slate-300">Ваше имя</label>
        <input
          autoFocus
          maxLength={24}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например, Аня"
          className="rounded-2xl border border-white/10 bg-navy-900 px-4 py-4 text-xl text-white outline-none focus:border-violet-400"
        />
        {error && <div className="text-rose-300">{error}</div>}
        <Button size="lg" disabled={!name.trim() || busy || !connected}>
          {connected ? 'Войти в игру' : 'Нет связи с сервером…'}
        </Button>
      </form>
    </Centered>
  );
}

function PlayerGame({
  view,
  socket,
  connected,
  sound,
  onToggleSound,
  onLeave,
}: {
  view: GameView;
  socket: Socket | null;
  connected: boolean;
  sound: boolean;
  onToggleSound: () => void;
  onLeave: () => void;
}) {
  const [showBoard, setShowBoard] = useState(false);
  const me = view.me!;
  const q = view.question;
  const toast = useMyEventToast(view);

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio);
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col">
      <ConnectionBadge connected={connected} />
      <RoundIntro view={view} />
      <PauseOverlay paused={view.paused} />
      {toast}

      <header className="flex items-center gap-3 border-b border-white/5 px-4 py-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{me.name}</div>
          <div className="text-xs text-slate-400">{view.pkg?.rounds[view.roundIndex]?.name ? roundTitle(view.pkg.rounds[view.roundIndex].name) : view.pkg?.name}</div>
        </div>
        <div className={cx('text-3xl font-black tabular-nums', me.score < 0 ? 'text-rose-300' : 'text-amber-200')}>{me.score}</div>
        <button onClick={onToggleSound} className="rounded-xl bg-white/5 px-3 py-2 text-xl" title="Звук на телефоне">
          {sound ? '🔊' : '🔇'}
        </button>
        <button onClick={() => setShowBoard(true)} className="rounded-xl bg-white/5 px-3 py-2 text-xl" title="Таблица">
          🏆
        </button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {view.phase === 'lobby' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center pop-in">
            <div className="text-6xl">🎉</div>
            <div className="text-2xl font-black">Вы в игре!</div>
            <div className="text-slate-400">Ждём, пока ведущий начнёт…</div>
            <div className="w-full max-w-sm">
              <Leaderboard players={view.players} meId={me.id} />
            </div>
          </div>
        )}
        {view.phase === 'board' && view.board && (
          <div className="flex flex-col gap-4 fade-in">
            <div className="text-center text-slate-300">
              {view.chooserId === me.id ? (
                <span className="font-bold text-amber-200">👑 Ваш выбор! Назовите вопрос ведущему</span>
              ) : view.chooserId ? (
                <>Выбирает: <b>{playerName(view, view.chooserId)}</b></>
              ) : (
                'Ведущий выбирает вопрос'
              )}
            </div>
            {view.lastAnswer && <LastAnswer a={view.lastAnswer} />}
            <Board board={view.board} compact />
            {view.board.remaining === 0 && <div className="text-center text-slate-400">Раунд сыгран. Ждём следующего…</div>}
          </div>
        )}
        {view.phase === 'final' && view.final && (
          <div className="flex flex-col gap-3 fade-in">
            <div className="text-center text-2xl font-black">Финал</div>
            <div className="text-center text-slate-400">Ведущий убирает темы</div>
            {view.final.themes.map((t, i) => (
              <div key={i} className={cx('rounded-xl px-4 py-3 text-center font-semibold', t.removed ? 'bg-white/5 text-slate-500 line-through' : 'tile')}>
                {t.name}
              </div>
            ))}
          </div>
        )}
        {view.phase === 'question' && q && (
          <div className="flex flex-1 flex-col items-center justify-center">
            <QuestionDisplay view={view} q={q} sound={sound} compact />
          </div>
        )}
        {view.phase === 'gameOver' && <GameOver players={view.players} />}
      </main>

      {view.phase === 'question' && q && (
        <footer className="shrink-0 px-4 pt-2" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
          {q.timer && !q.timer.expired && (q.stage === 'content' || q.stage === 'answering') && (
            <div className="mb-2 flex justify-center">
              <QuestionTimer timer={q.timer} />
            </div>
          )}
          {q.timer?.expired && <ExpiredSound />}
          <PlayerControls view={view} q={q} socket={socket} />
        </footer>
      )}

      <div className="px-4 pb-2 text-center">
        <button onClick={onLeave} className="text-xs text-slate-500 underline-offset-2 hover:underline">
          Выйти из игры
        </button>
      </div>

      {showBoard && (
        <div className="fixed inset-0 z-40 flex items-end bg-navy-950/70 backdrop-blur-sm fade-in sm:items-center sm:justify-center" onClick={() => setShowBoard(false)}>
          <div className="glass max-h-[80dvh] w-full overflow-y-auto rounded-t-3xl p-5 sm:max-w-md sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xl font-black">Таблица очков</div>
              <Button variant="subtle" size="sm" onClick={() => setShowBoard(false)}>
                Закрыть
              </Button>
            </div>
            <Leaderboard players={view.players} meId={me.id} chooserId={view.chooserId} />
          </div>
        </div>
      )}
    </div>
  );
}

function useMyEventToast(view: GameView) {
  const [toast, setToast] = useState<{ id: number; text: string; good: boolean } | null>(null);
  const lastId = useRef<number | null>(null);
  useEffect(() => {
    const e = view.lastEvent;
    if (!e) return;
    if (lastId.current === null) {
      lastId.current = e.id;
      return;
    }
    if (e.id === lastId.current) return;
    lastId.current = e.id;
    if (e.playerId !== view.me?.id || e.kind === 'buzz') return;
    const sign = e.delta > 0 ? '+' : '';
    const text =
      e.kind === 'correct' ? `Верно! ${sign}${e.delta}` : e.kind === 'wrong' ? `Неверно ${e.delta !== 0 ? e.delta : ''}` : `Очки: ${sign}${e.delta}`;
    setToast({ id: e.id, text, good: e.kind === 'correct' || (e.kind === 'adjust' && e.delta >= 0) });
    navigator.vibrate?.(e.kind === 'correct' ? [60, 40, 60] : 150);
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [view.lastEvent, view.me?.id]);
  if (!toast) return null;
  return (
    <div key={toast.id} className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
      <div className={cx('toast rounded-2xl px-6 py-3 text-2xl font-black shadow-2xl', toast.good ? 'bg-emerald-500 text-white' : 'bg-rose-600 text-white')}>
        {toast.text}
      </div>
    </div>
  );
}

function PlayerControls({ view, q, socket }: { view: GameView; q: QuestionViewData; socket: Socket | null }) {
  const me = view.me!;
  if (q.written) return <WrittenControls q={q} socket={socket} meId={me.id} />;
  if (q.stage === 'intro') return <StatusCard text="Ведущий настраивает вопрос…" />;
  if (q.stage === 'answer') {
    // Keep the screen free for the answer media; just summarize the outcome.
    const last = q.answered[q.answered.length - 1];
    if (!last) return null;
    const who = last.playerId === me.id ? 'Вы' : playerName(view, last.playerId);
    return (
      <div className={cx('rounded-2xl px-4 py-3 text-center font-bold', last.correct ? 'bg-emerald-500/15 text-emerald-100' : 'bg-rose-500/10 text-rose-200')}>
        {who}: {last.correct ? 'верно' : 'неверно'} {last.delta > 0 ? `+${last.delta}` : last.delta !== 0 ? last.delta : ''}
      </div>
    );
  }
  if (q.responderId) {
    return q.responderId === me.id ? (
      <StatusCard text="Отвечаете вы! Скажите ответ ведущему" tone="good" />
    ) : (
      <StatusCard text={`Отвечает ${playerName(view, q.responderId)}`} />
    );
  }
  return <Buzzer view={view} q={q} socket={socket} />;
}

function StatusCard({ text, tone }: { text: string; tone?: 'good' | 'bad' }) {
  return (
    <div
      className={cx(
        'rounded-3xl px-5 py-6 text-center text-xl font-bold',
        tone === 'good' ? 'bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-400' : tone === 'bad' ? 'bg-rose-500/15 text-rose-200' : 'glass text-slate-200',
      )}
    >
      {text}
    </div>
  );
}

function Buzzer({ view, q, socket }: { view: GameView; q: QuestionViewData; socket: Socket | null }) {
  const me = view.me!.id;
  const b = q.buzzer;
  const [pressed, setPressed] = useState(false);
  // False-start lockout deadline (local clock), driven by the server's ack and view.
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (q.myLockMs && q.myLockMs > 0) setLockUntil((u) => Math.max(u, Date.now() + q.myLockMs!));
  }, [q.myLockMs]);

  const locked = now < lockUntil;
  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [locked]);

  const base =
    b.winnerId === me
      ? 'won'
      : b.winnerId
        ? 'other'
        : b.blocked.includes(me)
          ? 'blocked'
          : q.stage === 'answer'
            ? 'done'
            : b.open
              ? 'open'
              : 'closed';
  const status = locked && (base === 'open' || base === 'closed') ? 'locked' : base;

  useEffect(() => {
    setPressed(false);
  }, [b.open, b.winnerId]);

  // Clear cue when the server activates the buzzer: flash, beep, vibration (no countdown shown before).
  const [activated, setActivated] = useState(false);
  const wasOpen = useRef(b.open);
  useEffect(() => {
    if (b.open && !wasOpen.current) {
      setActivated(true);
      activationBeep();
      navigator.vibrate?.(40);
      const t = setTimeout(() => setActivated(false), 400);
      wasOpen.current = b.open;
      return () => clearTimeout(t);
    }
    wasOpen.current = b.open;
  }, [b.open]);

  useEffect(() => {
    if (status === 'won') navigator.vibrate?.(250);
  }, [status]);

  const press = () => {
    // Every press goes to the server: it decides between a win and a false start.
    if (status === 'open' && pressed) return;
    if (status !== 'open' && status !== 'closed' && status !== 'locked') return;
    if (status === 'open') setPressed(true);
    navigator.vibrate?.(30);
    socket?.emit('buzz', null, (r: { won?: boolean; lockMs?: number }) => {
      if (r?.lockMs) {
        setPressed(false);
        setNow(Date.now());
        setLockUntil(Date.now() + r.lockMs);
        navigator.vibrate?.([80, 40, 80]);
      }
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        press();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const winnerName = playerName(view, b.winnerId);
  const order = b.order.find((o) => o.playerId === me);
  const label = {
    won: 'ВЫ ОТВЕЧАЕТЕ!',
    other: `Отвечает ${winnerName}`,
    blocked: 'Вы уже отвечали',
    done: 'Ответ открыт',
    open: pressed ? '…' : 'ЖМИ!',
    closed: 'Ждите…',
    locked: `Фальстарт! ${(Math.max(0, lockUntil - now) / 1000).toFixed(1)}`,
  }[status];

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          press();
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={cx(
          'no-select flex h-[38dvh] max-h-80 min-h-44 w-full max-w-md items-center justify-center rounded-[2.5rem] text-4xl font-black tracking-wide transition duration-100',
          status === 'open' && !pressed && (activated ? 'buzz-activate' : 'buzz-ready'),
          status === 'open' && !pressed && 'bg-gradient-to-br from-fuchsia-500 via-violet-600 to-blue-600 text-white active:scale-95',
          status === 'open' && pressed && 'scale-95 bg-violet-800 text-white',
          status === 'won' && 'bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-2xl shadow-emerald-700/50',
          status === 'other' && 'bg-navy-800 text-slate-300',
          status === 'blocked' && 'bg-rose-900/40 text-rose-200',
          status === 'closed' && 'bg-navy-800 text-slate-500',
          status === 'locked' && 'bg-rose-700/60 text-rose-50',
          status === 'done' && 'bg-navy-800 text-slate-500',
        )}
      >
        <span className="px-4 text-center">{label}</span>
      </button>
      <div className="h-5 text-sm text-slate-400">
        {status === 'other' && order && `Вы нажали на ${order.ms - b.order[0].ms} мс позже`}
        {status === 'won' && b.order[0] && `Реакция: ${b.order[0].ms} мс`}
        {status === 'locked' && 'Нажали раньше времени — подождите'}
        {status === 'closed' && 'Не жмите раньше времени — будет фальстарт'}
      </div>
    </div>
  );
}

function WrittenControls({ q, socket, meId }: { q: QuestionViewData; socket: Socket | null; meId: string }) {
  const mine = q.mine;
  const [stake, setStake] = useState('');
  const [answer, setAnswer] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  if (!mine) return <StatusCard text="Вы наблюдаете за этим вопросом" />;

  if (q.stage === 'stakes') {
    if (mine.stake !== undefined) return <StatusCard text={`Ставка принята: ${mine.stake}`} tone="good" />;
    if (mine.maxStake <= 0) return <StatusCard text="У вас нет очков — ваша ставка 0" />;
    const send = async (v: number) => {
      const r = await emitAck(socket, 'player:stake', { amount: v });
      setError(r.ok ? '' : (r.error ?? 'Ошибка'));
    };
    return (
      <div className="glass flex flex-col gap-3 rounded-3xl p-4">
        <div className="text-center font-bold">Ваша ставка (1 – {mine.maxStake})</div>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={mine.maxStake}
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          className="rounded-2xl border border-white/10 bg-navy-900 px-4 py-3 text-center text-2xl font-bold outline-none focus:border-violet-400"
        />
        {error && <div className="text-center text-rose-300">{error}</div>}
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => send(Number(stake))} disabled={!stake}>
            Поставить
          </Button>
          <Button variant="danger" onClick={() => send(mine.maxStake)}>
            Ва-банк ({mine.maxStake})
          </Button>
        </div>
      </div>
    );
  }

  if (q.stage === 'content' && mine.canAnswer) {
    if (mine.text && !editing) {
      return (
        <div className="flex flex-col gap-2">
          <StatusCard text={`Ответ отправлен: «${mine.text}»`} tone="good" />
          <Button variant="ghost" onClick={() => { setAnswer(mine.text ?? ''); setEditing(true); }}>
            Изменить ответ
          </Button>
        </div>
      );
    }
    return (
      <form
        className="glass flex flex-col gap-3 rounded-3xl p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await emitAck(socket, 'player:answer', { text: answer });
          if (r.ok) {
            setEditing(false);
            setError('');
          } else setError(r.error ?? 'Ошибка');
        }}
      >
        <div className="text-center font-bold">Ваш ответ{mine.stake !== undefined ? ` (ставка ${mine.stake})` : ''}</div>
        <input
          value={answer}
          maxLength={300}
          onChange={(e) => setAnswer(e.target.value)}
          className="rounded-2xl border border-white/10 bg-navy-900 px-4 py-3 text-xl outline-none focus:border-violet-400"
          placeholder="Напишите ответ"
        />
        {error && <div className="text-center text-rose-300">{error}</div>}
        <Button disabled={!answer.trim()}>Отправить</Button>
      </form>
    );
  }

  if (q.stage === 'review') return <StatusCard text="Ведущий проверяет ответы…" />;
  if (q.stage === 'answer') {
    const w = q.written?.find((x) => x.playerId === meId);
    if (w?.verdict === true) return <StatusCard text="Ваш ответ засчитан!" tone="good" />;
    if (w?.verdict === false) return <StatusCard text="Ответ не засчитан" tone="bad" />;
    return null;
  }
  return <StatusCard text="Приём ответов закрыт" />;
}

function LastAnswer({ a }: { a: NonNullable<GameView['lastAnswer']> }) {
  return (
    <div className="rounded-2xl bg-emerald-500/10 px-4 py-3 ring-1 ring-emerald-400/30 pop-in">
      <div className="text-xs font-bold uppercase tracking-widest text-emerald-300">
        Ответ на прошлый вопрос · {a.themeName}
        {a.price > 0 ? ` · ${a.price}` : ''}
      </div>
      <div className="mt-1 text-lg font-bold text-emerald-50">{a.text}</div>
    </div>
  );
}

/** Plays the timeout sound once when the timer runs out (the timer bar itself is hidden then). */
function ExpiredSound() {
  useEffect(() => {
    timeoutSound();
  }, []);
  return null;
}
