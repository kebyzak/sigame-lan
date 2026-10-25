import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { BoardView, ContentView, GameView, LanInfo, OptionView, PlayerView, QuestionType, QuestionViewData } from '../../shared/types';
import { timeoutSound } from '../sound';

export const TYPE_LABELS: Record<QuestionType, string> = {
  simple: '',
  stake: 'Аукцион',
  secret: 'Кот в мешке',
  secretPublicPrice: 'Кот в мешке',
  secretNoQuestion: 'Кот без вопроса',
  noRisk: 'Вопрос без риска',
  forAll: 'Вопрос для всех',
  stakeAll: 'Ставки',
};

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'success' | 'danger' | 'subtle'; size?: 'sm' | 'md' | 'lg' }) {
  const v = {
    primary: 'bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white shadow-lg shadow-violet-900/40',
    success: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/40',
    ghost: 'bg-white/5 hover:bg-white/10 text-slate-100 border border-white/10',
    subtle: 'text-slate-300 hover:text-white hover:bg-white/5',
  }[variant];
  const s = { sm: 'px-2.5 py-1 text-sm rounded-lg', md: 'px-4 py-2 rounded-xl', lg: 'px-6 py-3 text-lg rounded-2xl' }[size];
  return (
    <button
      {...rest}
      className={cx('font-semibold transition active:scale-[.97] disabled:opacity-40 disabled:pointer-events-none', v, s, className)}
    />
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide', className ?? 'bg-violet-500/20 text-violet-200')}>
      {children}
    </span>
  );
}

// ---------- content ----------

function textSize(t: string) {
  const n = t.length;
  if (n < 40) return 'text-3xl md:text-5xl';
  if (n < 120) return 'text-2xl md:text-4xl';
  if (n < 260) return 'text-xl md:text-3xl';
  return 'text-lg md:text-2xl';
}

export function ContentItems({
  items,
  sound,
  autoPlay = true,
  compact = false,
  hideAudio = false,
  onMediaStart,
}: {
  items: ContentView[];
  sound: boolean;
  autoPlay?: boolean;
  compact?: boolean;
  hideAudio?: boolean;
  /** Called when audio/video actually starts playing (used by the host to start the buzzer countdown). */
  onMediaStart?: () => void;
}) {
  const visual = items.filter((i) => i.kind !== 'audio');
  const audio = items.filter((i) => i.kind === 'audio');
  const images = visual.filter((i) => i.kind === 'image' && !i.missing).length;
  return (
    <div className="flex w-full flex-col items-center gap-4">
      {visual.map((it, i) => (
        <ContentItem key={(it.url ?? it.text ?? '') + i} item={it} sound={sound} autoPlay={autoPlay} compact={compact} multi={images > 1} onPlaying={onMediaStart} />
      ))}
      {!hideAudio &&
        audio.map((it, i) => <AudioItem key={(it.url ?? '') + i} item={it} sound={sound} autoPlay={autoPlay} compact={compact} onPlaying={onMediaStart} />)}
    </div>
  );
}

function ContentItem({
  item,
  sound,
  autoPlay,
  compact,
  multi,
  onPlaying,
}: {
  item: ContentView;
  sound: boolean;
  autoPlay: boolean;
  compact: boolean;
  multi: boolean;
  onPlaying?: () => void;
}) {
  if (item.missing) {
    return <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-amber-200">Файл не найден: {item.name}</div>;
  }
  switch (item.kind) {
    case 'text':
      if (item.placement === 'replic') {
        return <div className="max-w-3xl text-center text-lg italic text-violet-200">🎙 {item.text}</div>;
      }
      return (
        <div className={cx('max-w-4xl whitespace-pre-line text-center font-semibold leading-tight text-white', compact ? 'text-lg md:text-2xl' : textSize(item.text ?? ''))}>
          {item.text}
        </div>
      );
    case 'image':
      return (
        <img
          src={item.url}
          alt=""
          className={cx('rounded-xl object-contain shadow-2xl shadow-black/50', compact ? 'max-h-[34vh]' : multi ? 'max-h-[30vh]' : 'max-h-[55vh]', 'max-w-full')}
        />
      );
    case 'video':
      return (
        <video
          onPlaying={onPlaying}
          src={item.url}
          autoPlay={autoPlay}
          playsInline
          controls
          muted={!sound}
          className={cx('max-w-full rounded-xl shadow-2xl', compact ? 'max-h-[34vh]' : 'max-h-[55vh]')}
        />
      );
    case 'html':
      return <iframe src={item.url} sandbox="" className="h-[50vh] w-full max-w-4xl rounded-xl bg-white" title="html" />;
    default:
      return null;
  }
}

function AudioItem({
  item,
  sound,
  autoPlay,
  compact,
  onPlaying,
}: {
  item: ContentView;
  sound: boolean;
  autoPlay: boolean;
  compact: boolean;
  onPlaying?: () => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const a = ref.current;
    if (!a || !autoPlay || !sound) return;
    a.play().catch(() => setBlocked(true));
  }, [autoPlay, sound, item.url]);
  if (item.missing) return <div className="text-amber-200">Аудио не найдено: {item.name}</div>;
  if (!sound) {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-violet-500/15 px-5 py-3 text-violet-100">
        <span className="text-3xl">🎵</span>
        <span className={compact ? 'text-base' : 'text-xl'}>Звучит музыкальный фрагмент</span>
      </div>
    );
  }
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-2">
      {!compact && <div className="text-6xl">🎵</div>}
      <audio ref={ref} src={item.url} controls preload="auto" className="w-full" onPlay={() => setBlocked(false)} onPlaying={onPlaying} />
      {blocked && <div className="text-sm text-amber-300">Нажмите ▶, чтобы воспроизвести</div>}
    </div>
  );
}

export function Options({ options, correct, compact }: { options: OptionView[]; correct?: string; compact?: boolean }) {
  return (
    <div className={cx('grid w-full max-w-3xl gap-3', options.length > 2 ? 'sm:grid-cols-2' : 'grid-cols-2')}>
      {options.map((o) => (
        <div
          key={o.label}
          className={cx(
            'flex items-center gap-3 rounded-2xl border px-4 py-3 transition',
            correct === o.label ? 'border-emerald-400 bg-emerald-500/20' : correct ? 'border-white/10 bg-white/5 opacity-50' : 'border-indigo-400/30 bg-indigo-500/10',
          )}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-600 font-bold">{o.label}</span>
          <div className="min-w-0 flex-1 text-left">
            {o.content.map((c, i) =>
              c.kind === 'image' ? (
                <img key={i} src={c.url} alt="" className="max-h-32 rounded-lg" />
              ) : (
                <div key={i} className={cx('font-semibold', compact ? 'text-base' : 'text-xl')}>
                  {c.text}
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- board ----------

export function Board({
  board,
  onSelect,
  compact = false,
}: {
  board: BoardView;
  onSelect?: (theme: number, question: number) => void;
  compact?: boolean;
}) {
  const cols = Math.max(1, ...board.themes.map((t) => t.questions.length));
  return (
    <div className="w-full overflow-x-auto">
      <div
        className={cx('grid min-w-fit', compact ? 'gap-1' : 'gap-2')}
        style={{ gridTemplateColumns: `minmax(${compact ? '88px' : '180px'}, ${compact ? '120px' : '280px'}) repeat(${cols}, minmax(${compact ? '42px' : '84px'}, 1fr))` }}
      >
        {board.themes.map((t, ti) => (
          <BoardRow key={ti} theme={t} ti={ti} cols={cols} onSelect={onSelect} compact={compact} />
        ))}
      </div>
    </div>
  );
}

function BoardRow({
  theme,
  ti,
  cols,
  onSelect,
  compact,
}: {
  theme: BoardView['themes'][number];
  ti: number;
  cols: number;
  onSelect?: (t: number, q: number) => void;
  compact: boolean;
}) {
  const done = theme.questions.every((q) => q.used || q.empty);
  return (
    <>
      <div
        className={cx(
          'flex items-center rounded-xl bg-navy-800/80 font-semibold leading-tight',
          compact ? 'px-2 py-1.5 text-[11px]' : 'px-4 py-3 text-base',
          done && 'opacity-40',
        )}
        title={theme.name}
      >
        <span className={compact ? 'line-clamp-2' : 'line-clamp-2'}>{theme.name}</span>
      </div>
      {Array.from({ length: cols }, (_, qi) => {
        const q = theme.questions[qi];
        if (!q || q.empty) return <div key={qi} />;
        const clickable = !!onSelect && !q.used;
        return (
          <button
            key={qi}
            disabled={!clickable}
            onClick={() => onSelect?.(ti, qi)}
            className={cx(
              'rounded-xl font-black tabular-nums transition',
              compact ? 'py-1.5 text-sm' : 'py-3 text-2xl',
              q.used ? 'border border-white/5 bg-transparent text-transparent' : 'tile text-amber-200',
              clickable && 'hover:scale-[1.04] hover:brightness-125 active:scale-95 cursor-pointer',
              !onSelect && 'cursor-default',
            )}
          >
            {q.used ? '·' : q.price}
          </button>
        );
      })}
    </>
  );
}

// ---------- scores ----------

export function Leaderboard({ players, meId, chooserId, answeringId }: { players: PlayerView[]; meId?: string; chooserId?: string | null; answeringId?: string | null }) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return (
    <div className="flex flex-col gap-1.5">
      {sorted.map((p, i) => (
        <div
          key={p.id}
          className={cx(
            'flex items-center gap-3 rounded-xl px-3 py-2 transition',
            p.id === answeringId ? 'bg-emerald-500/20 ring-1 ring-emerald-400' : p.id === meId ? 'bg-violet-500/20 ring-1 ring-violet-400/50' : 'bg-white/5',
          )}
        >
          <span className="w-5 text-right text-sm text-slate-400">{i + 1}</span>
          <span className={cx('h-2 w-2 rounded-full', p.online ? 'bg-emerald-400' : 'bg-slate-600')} />
          <span className="min-w-0 flex-1 truncate font-semibold">
            {p.name}
            {p.id === chooserId && <span title="Выбирает вопрос"> 👑</span>}
          </span>
          <span className={cx('font-black tabular-nums', p.score < 0 ? 'text-rose-300' : 'text-amber-200')}>{p.score}</span>
        </div>
      ))}
      {players.length === 0 && <div className="py-4 text-center text-slate-400">Пока никого нет</div>}
    </div>
  );
}

export function ScoreStrip({ players, answeringId }: { players: PlayerView[]; answeringId?: string | null }) {
  return (
    <div className="flex flex-wrap justify-center gap-3">
      {players.map((p) => (
        <div
          key={p.id}
          className={cx(
            'min-w-32 rounded-2xl px-5 py-2 text-center transition',
            p.id === answeringId ? 'scale-105 bg-emerald-500/25 ring-2 ring-emerald-400' : 'glass',
            !p.online && 'opacity-50',
          )}
        >
          <div className="truncate text-sm font-semibold text-slate-300">{p.name}</div>
          <div className={cx('text-2xl font-black tabular-nums', p.score < 0 ? 'text-rose-300' : 'text-amber-200')}>{p.score}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- LAN QR ----------

export function useLanInfo() {
  const [info, setInfo] = useState<LanInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/info')
        .then((r) => r.json())
        .then((d) => alive && setInfo(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return info;
}

export function JoinQr({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const info = useLanInfo();
  const [idx, setIdx] = useState(0);
  if (!info) return <div className="text-slate-400">Определяем адрес…</div>;
  if (info.addresses.length === 0) {
    return <div className="rounded-xl bg-amber-500/10 p-4 text-amber-200">Не найден адрес в локальной сети. Подключите компьютер к Wi-Fi.</div>;
  }
  const a = info.addresses[Math.min(idx, info.addresses.length - 1)];
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={cx('rounded-2xl bg-white p-3 [&_svg]:h-full [&_svg]:w-full', size === 'lg' ? 'h-64 w-64' : 'h-40 w-40')}
        dangerouslySetInnerHTML={{ __html: a.qrSvg }}
      />
      <div className={cx('font-mono font-bold text-white', size === 'lg' ? 'text-2xl' : 'text-lg')}>{a.url.replace(/\/$/, '')}</div>
      {info.addresses.length > 1 && (
        <select
          className="rounded-lg bg-navy-800 px-2 py-1 text-sm text-slate-300"
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
        >
          {info.addresses.map((x, i) => (
            <option key={x.address} value={i}>
              {x.address} ({x.iface})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------- overlays ----------

export function RoundIntro({ view }: { view: GameView | null }) {
  const [shown, setShown] = useState<{ key: string; name: string } | null>(null);
  const last = useRef<string | null>(null);
  const round = view?.pkg?.rounds[view.roundIndex];
  const active = view && (view.phase === 'board' || view.phase === 'final');
  const key = active && round ? `${view.pkg!.id}:${view.roundIndex}` : null;
  useEffect(() => {
    if (!key || !round) return;
    if (last.current === null) {
      last.current = key;
      return;
    }
    if (last.current !== key) {
      last.current = key;
      setShown({ key, name: round.type === 'final' ? (/финал/i.test(round.name) ? round.name : `Финал: ${round.name}`) : roundTitle(round.name) });
      const t = setTimeout(() => setShown(null), 2400);
      return () => clearTimeout(t);
    }
  }, [key, round]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-navy-950/70">
      <div className="round-intro bg-gradient-to-r from-blue-400 to-fuchsia-400 bg-clip-text px-6 text-center text-5xl font-black text-transparent md:text-7xl">
        {shown.name}
      </div>
    </div>
  );
}

export function PauseOverlay({ paused }: { paused: boolean }) {
  if (!paused) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-navy-950/80 backdrop-blur-sm fade-in">
      <div className="text-center">
        <div className="text-7xl">⏸</div>
        <div className="mt-3 text-3xl font-black">Пауза</div>
      </div>
    </div>
  );
}

export function ConnectionBadge({ connected }: { connected: boolean }) {
  if (connected) return null;
  return (
    <div className="fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded-full bg-amber-500 px-4 py-1 text-sm font-bold text-navy-950 shadow-lg">
      Переподключение…
    </div>
  );
}

export function GameOver({ players }: { players: PlayerView[] }) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 py-8 pop-in">
      <div className="text-5xl">🏆</div>
      <div className="text-4xl font-black">Игра окончена</div>
      {sorted[0] && (
        <div className="text-center text-xl text-slate-300">
          Победитель: <span className="font-black text-amber-200">{sorted[0].name}</span>
        </div>
      )}
      <div className="flex w-full flex-col gap-2">
        {sorted.map((p, i) => (
          <div key={p.id} className={cx('flex items-center gap-3 rounded-2xl px-4 py-3', i === 0 ? 'bg-amber-400/15 ring-1 ring-amber-300/50' : 'glass')}>
            <span className="w-8 text-2xl">{medals[i] ?? i + 1}</span>
            <span className="flex-1 truncate text-lg font-semibold">{p.name}</span>
            <span className="text-2xl font-black tabular-nums text-amber-200">{p.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const roundTitle = (name: string) => (/^\d+$/.test(name.trim()) ? `Раунд ${name}` : name);

export function playerName(view: GameView, id: string | null | undefined) {
  return view.players.find((p) => p.id === id)?.name ?? '—';
}

/** Counts down locally from a server-provided remaining time; re-syncs on every update. */
export function useCountdown(remainingMs: number | undefined, running: boolean) {
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    setDeadline(Date.now() + (remainingMs ?? 0));
  }, [remainingMs, running]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  return running ? Math.max(0, deadline - now) : (remainingMs ?? 0);
}

/** No-answer countdown (server-authoritative), shown to the host, players and the TV screen. */
export function QuestionTimer({ timer, size = 'sm', sound = false }: { timer: NonNullable<QuestionViewData['timer']>; size?: 'sm' | 'lg'; sound?: boolean }) {
  const left = useCountdown(timer.remainingMs, timer.running);
  const wasExpired = useRef(timer.expired);
  useEffect(() => {
    if (timer.expired && !wasExpired.current && sound) timeoutSound();
    wasExpired.current = timer.expired;
  }, [timer.expired, sound]);
  const urgent = !timer.expired && left < 5000;
  const pct = timer.totalMs > 0 ? (left / timer.totalMs) * 100 : 0;
  const label = timer.expired ? 'Время вышло' : `${timer.running ? '' : '⏸ '}${Math.ceil(left / 1000)} с`;
  return (
    <div className={cx('w-full', size === 'lg' ? 'max-w-none' : 'max-w-md')}>
      <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-400">
        <span>⏱ Время на ответ</span>
        <span className={cx('tabular-nums', size === 'lg' ? 'text-2xl font-black' : 'text-sm', urgent ? 'animate-pulse text-rose-300' : 'text-slate-200')}>
          {label}
        </span>
      </div>
      <div className={cx('overflow-hidden rounded-full bg-white/10', size === 'lg' ? 'h-3' : 'h-1.5')}>
        <div
          className={cx('h-full rounded-full transition-[width] duration-100 ease-linear', urgent ? 'bg-rose-500' : 'bg-gradient-to-r from-blue-500 to-violet-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
