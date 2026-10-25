import type { GameView, QuestionViewData } from '../../shared/types';
import { Badge, ContentItems, Options, TYPE_LABELS, cx, playerName, useCountdown } from './common';

/** Public rendering of the current question (what everyone in the room may see). */
export function QuestionDisplay({
  view,
  q,
  sound,
  compact = false,
  onMediaStart,
}: {
  view: GameView;
  q: QuestionViewData;
  sound: boolean;
  compact?: boolean;
  onMediaStart?: () => void;
}) {
  const label = TYPE_LABELS[q.type];
  const isFinal = view.board?.type === 'final';
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex flex-wrap items-center justify-center gap-2 text-center">
        <span className={cx('font-semibold text-slate-300', compact ? 'text-sm' : 'text-lg')}>{q.themeName}</span>
        {q.type !== 'stakeAll' && q.price > 0 && <Badge className="bg-amber-400/20 text-amber-200">{q.price}</Badge>}
        {label && <Badge>{isFinal && q.type === 'stakeAll' ? 'Финал' : label}</Badge>}
      </div>

      {q.stage === 'intro' && <Intro view={view} q={q} compact={compact} />}

      {q.stage === 'stakes' && (
        <div className="flex flex-col items-center gap-3 py-6 pop-in">
          <div className={cx('font-black', compact ? 'text-3xl' : 'text-5xl')}>Делайте ставки!</div>
          <div className="text-slate-300">Ставки сделали: {q.written?.filter((w) => w.stakeSubmitted).length ?? 0} из {q.written?.length ?? 0}</div>
        </div>
      )}

      {(q.stage === 'content' || q.stage === 'answering' || q.stage === 'review') && q.content && (
        <div className="flex w-full flex-col items-center gap-4 pop-in">
          <ContentItems items={q.content} sound={sound} compact={compact} onMediaStart={onMediaStart} />
          {q.options && <Options options={q.options} compact={compact} />}
        </div>
      )}

      {q.stage === 'answer' && q.unanswered && (
        <div className="rounded-2xl bg-amber-500/15 px-5 py-2 text-center font-bold text-amber-200 ring-1 ring-amber-400/40 pop-in">
          {q.answered.length === 0 ? '⏰ Время вышло — никто не ответил' : '⏰ Время вышло'}
        </div>
      )}
      {q.stage === 'answer' && q.answer && <AnswerBlock q={q} sound={sound} compact={compact} />}
      {q.stage === 'answer' && q.returnMs !== undefined && <ReturnCountdown ms={q.returnMs} />}

      {q.written && (q.stage === 'review' || q.stage === 'answer') && q.written.some((w) => w.text !== undefined || w.verdict !== undefined) && (
        <div className="grid w-full max-w-3xl gap-2 sm:grid-cols-2">
          {q.written
            .filter((w) => w.verdict !== undefined)
            .map((w) => (
              <div
                key={w.playerId}
                className={cx(
                  'rounded-xl px-4 py-2 pop-in',
                  w.verdict === true ? 'bg-emerald-500/20 ring-1 ring-emerald-400/60' : w.verdict === false ? 'bg-rose-500/15 ring-1 ring-rose-400/50' : 'glass',
                )}
              >
                <div className="flex justify-between text-sm text-slate-300">
                  <span>{playerName(view, w.playerId)}</span>
                  {w.stake !== undefined && <span>ставка {w.stake}</span>}
                </div>
                <div className="font-semibold">{w.text ?? '— нет ответа —'}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function Intro({ view, q, compact }: { view: GameView; q: QuestionViewData; compact: boolean }) {
  const icon = q.type === 'stake' ? '🔨' : q.type === 'noRisk' ? '🛡️' : '🐱';
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center pop-in">
      <div className={compact ? 'text-6xl' : 'text-8xl'}>{icon}</div>
      <div className={cx('bg-gradient-to-r from-blue-300 to-fuchsia-300 bg-clip-text font-black text-transparent', compact ? 'text-3xl' : 'text-6xl')}>
        {TYPE_LABELS[q.type]}
      </div>
      {q.secretTheme && <div className="text-xl">Тема: <b>{q.secretTheme}</b></div>}
      {q.secretPrices && q.secretPrices.length > 0 && q.type !== 'stake' && (
        <div className="text-slate-300">Стоимость: {q.secretPrices.join(' / ')}</div>
      )}
      <div className="text-slate-400">
        {q.type === 'stake'
          ? 'Торгуйтесь! Ведущий объявит победителя аукциона'
          : q.type === 'noRisk'
            ? `Отвечает ${playerName(view, view.chooserId)} — без штрафа за ошибку, стоимость удвоена`
            : 'Ведущий выбирает, кому достанется вопрос'}
      </div>
    </div>
  );
}

function AnswerBlock({ q, sound, compact }: { q: QuestionViewData; sound: boolean; compact: boolean }) {
  const a = q.answer!;
  const correctText = a.correctOption ? q.options?.find((o) => o.label === a.correctOption)?.content.map((c) => c.text).join(' ') : null;
  const hasAnswerMedia = a.content.some((c) => c.kind !== 'text');
  return (
    <div className="flex w-full flex-col items-center gap-4 pop-in">
      <div className="text-sm font-bold uppercase tracking-[0.2em] text-emerald-300">Правильный ответ</div>
      <div className={cx('max-w-4xl text-center font-black text-emerald-100', compact ? 'text-2xl' : 'text-4xl md:text-5xl')}>
        {correctText ? `${a.correctOption}: ${correctText}` : a.right[0] ?? '—'}
      </div>
      {a.right.length > 1 && <div className="text-slate-300">Также принимается: {a.right.slice(1).join('; ')}</div>}
      {a.content.length > 0 && <ContentItems items={a.content} sound={sound} compact={compact} />}
      {!hasAnswerMedia && q.content && <ContentItems items={q.content} sound={sound} compact autoPlay={false} hideAudio />}
      {q.options && <Options options={q.options} correct={a.correctOption} compact />}
      {q.comment && <div className="max-w-3xl text-center text-slate-400">{q.comment}</div>}
    </div>
  );
}

function ReturnCountdown({ ms }: { ms: number }) {
  const left = useCountdown(ms, true);
  return <div className="text-sm text-slate-400">Возврат к табло через {Math.ceil(left / 1000)} с</div>;
}
