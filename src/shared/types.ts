// Types shared between the server and the client.

export type ContentKind = 'text' | 'image' | 'audio' | 'video' | 'html';
export type Placement = 'screen' | 'replic' | 'background';

/** Content item as stored in a parsed package (media referenced by id). */
export interface PkgContentItem {
  kind: ContentKind;
  text?: string;
  mediaId?: string;
  /** External URL (non-embedded media). */
  url?: string;
  placement: Placement;
  /** Original file name, for diagnostics. */
  name?: string;
  missing?: boolean;
}

export type QuestionType =
  | 'simple'
  | 'stake'
  | 'secret'
  | 'secretPublicPrice'
  | 'secretNoQuestion'
  | 'noRisk'
  | 'forAll'
  | 'stakeAll';

export interface PkgOption {
  label: string;
  content: PkgContentItem[];
}

export interface PkgQuestion {
  price: number;
  type: QuestionType;
  question: PkgContentItem[];
  answer: PkgContentItem[];
  right: string[];
  wrong: string[];
  answerType: 'text' | 'select' | 'number';
  options?: PkgOption[];
  answerDeviation?: number;
  /** For "secret" questions: theme announced instead of the real one. */
  secretTheme?: string;
  /** For "secret" questions: allowed prices to choose from. */
  secretPrices?: number[];
  comment?: string;
}

export interface PkgTheme {
  name: string;
  comment?: string;
  questions: PkgQuestion[];
}

export interface PkgRound {
  name: string;
  type: 'standard' | 'final';
  themes: PkgTheme[];
}

export interface PkgMedia {
  file: string;
  mime: string;
  kind: ContentKind;
  name: string;
  size: number;
}

export interface Package {
  id: string;
  name: string;
  author?: string;
  version: number;
  logoMediaId?: string;
  rounds: PkgRound[];
  media: Record<string, PkgMedia>;
  warnings: string[];
  importedAt: number;
}

export interface PackageSummary {
  id: string;
  name: string;
  author?: string;
  rounds: { name: string; type: 'standard' | 'final'; themes: number; questions: number }[];
  mediaCount: number;
  warnings: string[];
}

// ---------- Views sent to clients ----------

export interface ContentView {
  kind: ContentKind;
  text?: string;
  url?: string;
  placement: Placement;
  name?: string;
  missing?: boolean;
}

export interface OptionView {
  label: string;
  content: ContentView[];
}

export type Phase = 'lobby' | 'board' | 'final' | 'question' | 'gameOver';
export type QuestionStage = 'intro' | 'stakes' | 'content' | 'answering' | 'review' | 'answer';

export interface PlayerView {
  id: string;
  name: string;
  score: number;
  online: boolean;
}

export interface BuzzEntry {
  playerId: string;
  ms: number;
}

export interface WrittenView {
  playerId: string;
  submitted: boolean;
  stakeSubmitted: boolean;
  /** Revealed only to host, or to everyone at the answer stage. */
  text?: string;
  stake?: number;
  verdict?: boolean | null;
}

export interface QuestionViewData {
  themeName: string;
  price: number;
  type: QuestionType;
  stage: QuestionStage;
  responderId: string | null;
  content: ContentView[] | null;
  options: OptionView[] | null;
  answerType: 'text' | 'select' | 'number';
  /** Only present when revealed (or always for host). */
  answer: { content: ContentView[]; right: string[]; wrong: string[]; correctOption?: string } | null;
  comment?: string;
  secretTheme?: string;
  secretPrices?: number[];
  buzzer: { open: boolean; winnerId: string | null; blocked: string[]; order: BuzzEntry[]; falseStarts: string[] };
  /** For the current player: remaining false-start lockout. */
  myLockMs?: number;
  /** No-answer countdown (runs only while the buzzer is open). */
  timer?: { totalMs: number; remainingMs: number; running: boolean; paused: boolean; expired: boolean } | null;
  /** Nobody pressed the buzzer in time. */
  unanswered?: boolean;
  /** Time left until the automatic return to the board. */
  returnMs?: number;
  /** Host only: automatic buzzer activation status (never sent to players). */
  auto?: { mode: 'waitingMedia' | 'counting' | 'paused' | 'off' | 'done'; delayMs: number; remainingMs?: number; media: boolean };
  answered: { playerId: string; correct: boolean; delta: number }[];
  written: WrittenView[] | null;
  /** For the current player: own written answer and stake. */
  mine?: { text?: string; stake?: number; canAnswer: boolean; maxStake: number };
}

export interface BoardView {
  name: string;
  type: 'standard' | 'final';
  themes: { name: string; questions: { price: number; used: boolean; empty: boolean }[] }[];
  remaining: number;
}

export interface GameEvent {
  id: number;
  kind: 'correct' | 'wrong' | 'adjust' | 'buzz';
  playerId: string;
  delta: number;
}

export interface GameView {
  role: 'host' | 'player' | 'screen';
  me?: { id: string; name: string; score: number };
  pkg: { id: string; name: string; author?: string; logoUrl?: string; rounds: { name: string; type: string }[] } | null;
  phase: Phase;
  paused: boolean;
  roundIndex: number;
  board: BoardView | null;
  players: PlayerView[];
  chooserId: string | null;
  question: QuestionViewData | null;
  final: { stage: 'themes'; themes: { name: string; removed: boolean }[] } | null;
  lastEvent: GameEvent | null;
  lastAnswer: { themeName: string; price: number; text: string } | null;
  /** Host only. */
  settings?: { autoBuzzer: boolean; timeoutSec: number };
}

export type HostAction =
  | { type: 'startGame' }
  | { type: 'setRound'; index: number }
  | { type: 'selectQuestion'; theme: number; question: number }
  | { type: 'assignResponder'; playerId: string; price: number }
  | { type: 'openBuzzer' }
  | { type: 'closeBuzzer' }
  | { type: 'mediaStarted' }
  | { type: 'setSettings'; autoBuzzer?: boolean; timeoutSec?: number }
  | { type: 'timerPause' }
  | { type: 'timerReset' }
  | { type: 'setAnswering'; playerId: string }
  | { type: 'judge'; correct: boolean }
  | { type: 'closeStakes' }
  | { type: 'closeWritten' }
  | { type: 'judgeWritten'; playerId: string; correct: boolean }
  | { type: 'revealAnswer' }
  | { type: 'finishQuestion' }
  | { type: 'skipQuestion' }
  | { type: 'cancelQuestion' }
  | { type: 'finalRemoveTheme'; theme: number }
  | { type: 'finalPlayTheme'; theme: number }
  | { type: 'adjustScore'; playerId: string; delta: number }
  | { type: 'setScore'; playerId: string; score: number }
  | { type: 'setChooser'; playerId: string | null }
  | { type: 'kickPlayer'; playerId: string }
  | { type: 'togglePause' }
  | { type: 'endGame' }
  | { type: 'resetGame' };

export interface Ack {
  ok: boolean;
  error?: string;
}

export interface LanInfo {
  port: number;
  addresses: { address: string; iface: string; url: string; qrSvg: string }[];
}
