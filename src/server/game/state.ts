// Persisted game state (server-only; contains secrets such as player tokens).
import type { BuzzEntry, GameEvent, Phase, QuestionStage } from '../../shared/types.js';

export interface Player {
  id: string;
  token: string;
  name: string;
  score: number;
  joinedAt: number;
}

export interface WrittenEntry {
  text?: string;
  stake?: number;
  verdict?: boolean | null;
}

export interface AutoBuzzerState {
  /** Planned delay between the question becoming visible and the buzzer opening. */
  delayMs: number;
  /** Question has image/audio/video (random delay) rather than text (reading-time delay). */
  media: boolean;
  /** Audio/video: the countdown starts only once playback starts (or after a fallback). */
  waitingForMedia: boolean;
  /** Epoch ms when the buzzer opens; null when not counting. */
  activateAt: number | null;
  /** Countdown left when paused or disabled mid-count. */
  remainingMs: number | null;
  /** Fired, or superseded by a manual open/close. */
  done: boolean;
}

export interface QuestionTimeoutState {
  /** Full no-answer countdown (only runs while the buzzer is open). */
  totalMs: number;
  /** Remaining time while not running. */
  remainingMs: number;
  /** Epoch ms when it expires; null when not running. */
  endsAt: number | null;
  /** Paused by the moderator's timer button. */
  hostPaused: boolean;
  expired: boolean;
}

export interface ActiveQuestion {
  round: number;
  theme: number;
  question: number;
  price: number;
  stage: QuestionStage;
  /** Fixed responder for secret/stake/noRisk questions. */
  responderId: string | null;
  buzzer: {
    open: boolean;
    session: number;
    winnerId: string | null;
    blocked: string[];
    order: BuzzEntry[];
    /** Players who pressed too early in the current pre-open window. */
    falseStarts: string[];
    /** Buzzer was open when the game was paused — reopen on resume. */
    reopenAfterPause?: boolean;
  };
  answered: { playerId: string; correct: boolean; delta: number }[];
  /** For forAll / stakeAll questions. */
  participants: string[];
  written: Record<string, WrittenEntry>;
  /** Final round: question was launched from the final theme picker. */
  fromFinal: boolean;
  /** Automatic buzzer activation for classic buzzer questions. */
  auto?: AutoBuzzerState;
  /** No-answer timeout for classic buzzer questions. */
  timeout?: QuestionTimeoutState;
  /** Nobody pressed the buzzer in time. */
  unanswered?: boolean;
  /** Epoch ms of the automatic return to the board after an unanswered question. */
  returnAt?: number | null;
}

export interface FinalState {
  removed: number[];
}

export interface GameState {
  version: 1;
  packageId: string | null;
  phase: Phase;
  paused: boolean;
  roundIndex: number;
  used: string[];
  chooserId: string | null;
  players: Player[];
  question: ActiveQuestion | null;
  final: FinalState | null;
  lastEvent: GameEvent | null;
  eventSeq: number;
  /** Answer of the previous question, shown on the board afterwards. */
  lastAnswer: { themeName: string; price: number; text: string } | null;
  settings: { autoBuzzer: boolean; timeoutSec: number };
}

export function initialState(): GameState {
  return {
    version: 1,
    packageId: null,
    phase: 'lobby',
    paused: false,
    roundIndex: 0,
    used: [],
    chooserId: null,
    players: [],
    question: null,
    final: null,
    lastEvent: null,
    eventSeq: 0,
    lastAnswer: null,
    settings: { autoBuzzer: true, timeoutSec: 15 },
  };
}

export const qKey = (r: number, t: number, q: number) => `${r}:${t}:${q}`;
