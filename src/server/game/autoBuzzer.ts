// Automatic buzzer activation: how long to wait after a question is shown before
// the buzzer opens. Planned once per question on the server.
import type { PkgQuestion } from '../../shared/types.js';
import type { AutoBuzzerState } from './state.js';

export const AUTO_BUZZER = {
  /** Reading speed used to estimate how long a text question takes to read. */
  wordsPerMinute: 200,
  /** Added to every text estimate (time to look up from the board). */
  baseMs: 500,
  minTextMs: 1500,
  maxTextMs: 12000,
  /** Random window for questions with images, audio or video. */
  minMediaMs: 3000,
  maxMediaMs: 7000,
  /** Start counting anyway if the host never reports that audio/video started playing. */
  mediaStartFallbackMs: 4000,
};

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function planAutoBuzzer(pq: PkgQuestion, rand: () => number = Math.random): AutoBuzzerState {
  const items = pq.question.filter((i) => !i.missing);
  const media = items.some((i) => i.kind !== 'text');
  let delayMs: number;
  if (media) {
    delayMs = Math.round(AUTO_BUZZER.minMediaMs + rand() * (AUTO_BUZZER.maxMediaMs - AUTO_BUZZER.minMediaMs));
  } else {
    const texts = [...items.map((i) => i.text ?? ''), ...(pq.options ?? []).flatMap((o) => o.content.map((c) => c.text ?? ''))];
    const words = texts.reduce((n, t) => n + countWords(t), 0);
    const estimate = AUTO_BUZZER.baseMs + (words * 60000) / AUTO_BUZZER.wordsPerMinute;
    delayMs = Math.round(Math.min(AUTO_BUZZER.maxTextMs, Math.max(AUTO_BUZZER.minTextMs, estimate)));
  }
  return {
    delayMs,
    media,
    waitingForMedia: items.some((i) => i.kind === 'audio' || i.kind === 'video'),
    activateAt: null,
    remainingMs: null,
    done: false,
  };
}
