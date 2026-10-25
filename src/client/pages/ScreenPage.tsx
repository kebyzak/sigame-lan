import { useState } from 'react';
import { emitAck, useGameSocket } from '../socket';
import { Board, ConnectionBadge, GameOver, JoinQr, PauseOverlay, QuestionTimer, RoundIntro, ScoreStrip, cx, playerName, roundTitle } from '../components/common';
import { QuestionDisplay } from '../components/QuestionDisplay';

/** Big-screen view for a TV/projector: shows only public information. */
export function ScreenPage() {
  const [sound, setSound] = useState(false);
  const { view, connected } = useGameSocket((s) => {
    emitAck(s, 'screen:join');
  });

  if (!view) return <div className="flex h-[100dvh] items-center justify-center text-2xl text-slate-400">Подключение…</div>;
  const q = view.question;
  const answering = q?.buzzer.winnerId ?? q?.responderId ?? null;

  return (
    <div className="flex h-[100dvh] flex-col gap-4 p-6">
      <ConnectionBadge connected={connected} />
      <RoundIntro view={view} />
      <PauseOverlay paused={view.paused} />
      {!sound && (
        <button onClick={() => setSound(true)} className="fixed bottom-4 left-4 z-30 rounded-xl bg-white/10 px-4 py-2 text-sm">
          🔇 Включить звук на этом экране
        </button>
      )}
      <div className="flex items-center justify-between">
        <div className="text-2xl font-black">{view.pkg?.name ?? 'СИ-Игра'}</div>
        <div className="text-lg text-slate-300">{view.board && view.phase !== 'lobby' ? roundTitle(view.board.name) : ''}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden">
        {view.phase === 'lobby' && (
          <div className="flex flex-col items-center gap-6">
            <div className="text-4xl font-black">Подключайтесь к игре!</div>
            <JoinQr />
            <div className="text-slate-300">Игроков: {view.players.length}</div>
          </div>
        )}
        {view.phase === 'board' && view.board && (
          <div className="w-full max-w-7xl">
            {view.chooserId && <div className="mb-4 text-center text-xl text-slate-300">Выбирает: <b className="text-amber-200">{playerName(view, view.chooserId)}</b></div>}
            {view.lastAnswer && (
              <div className="mb-4 text-center text-lg text-slate-300">
                Прошлый ответ: <b className="text-emerald-200">{view.lastAnswer.text}</b>
              </div>
            )}
            <Board board={view.board} />
          </div>
        )}
        {view.phase === 'final' && view.final && (
          <div className="grid w-full max-w-4xl gap-3">
            <div className="mb-2 text-center text-4xl font-black">Финал</div>
            {view.final.themes.map((t, i) => (
              <div key={i} className={cx('rounded-2xl px-6 py-4 text-center text-2xl font-bold', t.removed ? 'bg-white/5 text-slate-600 line-through' : 'tile')}>
                {t.name}
              </div>
            ))}
          </div>
        )}
        {view.phase === 'question' && q && (
          <div className="flex w-full flex-col items-center gap-6">
            <QuestionDisplay view={view} q={q} sound={sound} />
            {answering && q.stage !== 'answer' && (
              <div className="rounded-2xl bg-emerald-500/20 px-8 py-3 text-3xl font-black text-emerald-100 ring-2 ring-emerald-400 pop-in">
                Отвечает: {playerName(view, answering)}
              </div>
            )}
            {q.buzzer.open && <div className="text-2xl font-black text-fuchsia-300 animate-pulse">Жмите кнопку!</div>}
            {q.timer && !q.timer.expired && (q.stage === 'content' || q.stage === 'answering') && (
              <div className="w-full max-w-2xl">
                <QuestionTimer timer={q.timer} size="lg" sound={sound} />
              </div>
            )}
          </div>
        )}
        {view.phase === 'gameOver' && <GameOver players={view.players} />}
      </div>
      {view.phase !== 'lobby' && view.phase !== 'gameOver' && <ScoreStrip players={view.players} answeringId={answering} />}
    </div>
  );
}
