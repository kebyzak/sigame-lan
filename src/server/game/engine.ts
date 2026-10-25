// Game engine: the single source of truth. All mutations go through here and the
// server is authoritative for buzzer arbitration and scoring.
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  ContentView,
  GameView,
  HostAction,
  Package,
  PkgContentItem,
  PkgQuestion,
  QuestionType,
  QuestionViewData,
  WrittenView,
} from '../../shared/types.js';
import { AUTO_BUZZER, planAutoBuzzer } from './autoBuzzer.js';
import { type ActiveQuestion, type GameState, type Player, qKey } from './state.js';

export class GameError extends Error {}

const RESPONDER_TYPES: QuestionType[] = ['stake', 'secret', 'secretPublicPrice', 'secretNoQuestion', 'noRisk'];
const WRITTEN_TYPES: QuestionType[] = ['forAll', 'stakeAll'];
const MAX_PLAYERS = 40;
export const TIMEOUT_OPTIONS = [0, 10, 15, 20, 30];
/** How long the answer stays on screen after an unanswered question before returning to the board. */
const RETURN_TO_BOARD_MS = 4000;

export class Game {
  private buzzOpenedAt = 0;
  /** False-start cooldowns: player id -> performance.now() deadline. Reset on every new question. */
  private locks = new Map<string, number>();
  /** Number of connected sockets per player id. */
  readonly online = new Map<string, number>();
  /** Pending automatic activation (or media-start fallback) for the current question. */
  private autoTimer: NodeJS.Timeout | null = null;
  /** No-answer countdown and the automatic return to the board that follows it. */
  private timeoutTimer: NodeJS.Timeout | null = null;
  private returnTimer: NodeJS.Timeout | null = null;

  constructor(
    public state: GameState,
    public pkg: Package | null,
    private onChange: () => void,
    /** Lockout after pressing too early (or spamming while locked); 0 disables false starts. */
    private falseStartMs = 0,
    /** Scales the no-answer timeout and return delay (tests only). */
    private timerScale = 1,
  ) {
    if (state.question?.buzzer.open) this.buzzOpenedAt = performance.now();
    if (state.question) state.question.buzzer.falseStarts ??= [];
    state.settings ??= { autoBuzzer: true, timeoutSec: 15 };
    state.settings.timeoutSec ??= 15;
    // Resume countdowns that were running when the server stopped.
    if (state.question?.auto) this.armAuto(state.question);
    if (state.question?.timeout) this.runTimeout(state.question);
    if (state.question?.returnAt) this.armReturn(state.question);
  }

  private changed() {
    this.onChange();
  }

  private event(kind: 'correct' | 'wrong' | 'adjust' | 'buzz', playerId: string, delta: number) {
    this.state.lastEvent = { id: ++this.state.eventSeq, kind, playerId, delta };
  }

  // ---------- package ----------

  setPackage(pkg: Package) {
    this.pkg = pkg;
    this.clearAuto();
    this.clearTimers();
    const s = this.state;
    s.packageId = pkg.id;
    s.phase = 'lobby';
    s.roundIndex = 0;
    s.used = [];
    s.question = null;
    s.final = null;
    s.chooserId = null;
    s.paused = false;
    for (const p of s.players) p.score = 0;
    this.changed();
  }

  // ---------- players ----------

  player(id: string | null | undefined): Player | undefined {
    return id ? this.state.players.find((p) => p.id === id) : undefined;
  }

  playerByToken(token: unknown): Player | undefined {
    if (typeof token !== 'string' || token.length < 16) return undefined;
    return this.state.players.find((p) => safeEqual(p.token, token));
  }

  join(rawName: unknown): Player {
    const name = String(rawName ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (!name) throw new GameError('Введите имя');
    if (this.state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('Это имя уже занято');
    }
    if (this.state.players.length >= MAX_PLAYERS) throw new GameError('Слишком много игроков');
    const p: Player = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(24).toString('hex'),
      name,
      score: 0,
      joinedAt: Date.now(),
    };
    this.state.players.push(p);
    // A player joining mid-question can take part in written questions still collecting stakes.
    const q = this.state.question;
    if (q && q.stage === 'stakes') q.participants.push(p.id);
    this.changed();
    return p;
  }

  setOnline(playerId: string, delta: number) {
    const n = (this.online.get(playerId) ?? 0) + delta;
    if (n <= 0) this.online.delete(playerId);
    else this.online.set(playerId, n);
    this.changed();
  }

  // ---------- player actions ----------

  /**
   * Server-authoritative buzzer: the first valid event processed wins.
   * Pressing while the question is shown but the buzzer is still closed is a false start:
   * the player is locked out for `falseStartMs`, and every press during the lockout extends it.
   */
  buzz(playerId: string): { won: boolean; lockMs: number } {
    const s = this.state;
    const q = s.question;
    const none = { won: false, lockMs: 0 };
    if (!q || s.paused || !this.player(playerId)) return none;
    const b = q.buzzer;
    const eligible = q.stage === 'content' && !q.responderId && !b.winnerId && !b.blocked.includes(playerId) && q.participants.length === 0;
    const now = performance.now();
    const locked = now < (this.locks.get(playerId) ?? 0);
    if (eligible && this.falseStartMs > 0 && (!b.open || locked)) {
      this.locks.set(playerId, now + this.falseStartMs);
      if (!b.falseStarts.includes(playerId)) {
        b.falseStarts.push(playerId);
        this.changed();
      }
      return { won: false, lockMs: this.falseStartMs };
    }
    if (eligible && b.open) {
      const ms = Math.round(now - this.buzzOpenedAt);
      b.open = false;
      b.winnerId = playerId;
      b.order = [{ playerId, ms }];
      q.stage = 'answering';
      this.haltTimeout(q);
      this.event('buzz', playerId, 0);
      this.changed();
      return { won: true, lockMs: 0 };
    }
    // Record late presses (for display only) within the same buzzer session.
    if (q.stage === 'answering' && b.winnerId && !b.blocked.includes(playerId) && !b.order.some((o) => o.playerId === playerId)) {
      const ms = Math.round(now - this.buzzOpenedAt);
      if (ms < 5000) {
        b.order.push({ playerId, ms });
        this.changed();
      }
    }
    return none;
  }

  private lockMsFor(playerId: string): number {
    return Math.max(0, Math.round((this.locks.get(playerId) ?? 0) - performance.now()));
  }

  submitStake(playerId: string, amount: unknown) {
    const q = this.requireQuestion();
    if (q.stage !== 'stakes' || !q.participants.includes(playerId)) throw new GameError('Сейчас нельзя сделать ставку');
    const p = this.player(playerId)!;
    const max = Math.max(p.score, 0);
    const v = Math.floor(Number(amount));
    if (!Number.isFinite(v) || v < 0 || v > max) throw new GameError(`Ставка должна быть от ${max > 0 ? 1 : 0} до ${max}`);
    if (max > 0 && v < 1) throw new GameError('Ставка должна быть не меньше 1');
    q.written[playerId] = { ...q.written[playerId], stake: v };
    this.changed();
  }

  submitAnswer(playerId: string, text: unknown) {
    const q = this.requireQuestion();
    const pq = this.pkgQuestion(q);
    if (!WRITTEN_TYPES.includes(pq.type) || q.stage !== 'content' || !q.participants.includes(playerId)) {
      throw new GameError('Сейчас нельзя отправить ответ');
    }
    const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!t) throw new GameError('Пустой ответ');
    q.written[playerId] = { ...q.written[playerId], text: t };
    this.changed();
  }

  // ---------- host actions ----------

  hostAction(a: HostAction) {
    if (!a || typeof a !== 'object') throw new GameError('Некорректное действие');
    const s = this.state;
    switch (a.type) {
      case 'startGame':
        if (!this.pkg) throw new GameError('Сначала загрузите пакет');
        return this.setRound(0);
      case 'setRound':
        return this.setRound(int(a.index));
      case 'selectQuestion':
        if (s.phase !== 'board') throw new GameError('Сейчас нельзя выбрать вопрос');
        return this.startQuestion(int(a.theme), int(a.question), false);
      case 'assignResponder':
        return this.assignResponder(String(a.playerId), int(a.price));
      case 'openBuzzer': {
        const q = this.requireQuestion();
        const pq = this.pkgQuestion(q);
        if (q.responderId || WRITTEN_TYPES.includes(pq.type)) throw new GameError('В этом вопросе кнопка не используется');
        if (q.stage !== 'content' && q.stage !== 'answering') throw new GameError('Сейчас нельзя открыть кнопку');
        this.finishAuto(q);
        return this.openBuzzer(q);
      }
      case 'closeBuzzer': {
        // Also cancels a pending automatic activation: the host takes over.
        const q = this.requireQuestion();
        this.finishAuto(q);
        q.buzzer.open = false;
        this.haltTimeout(q);
        return this.changed();
      }
      case 'mediaStarted': {
        // Host reports actual audio/video playback start; ignored unless we are waiting for it.
        const q = this.state.question;
        if (q?.auto?.waitingForMedia && !q.auto.done) {
          q.auto.waitingForMedia = false;
          this.armAuto(q);
          this.changed();
        }
        return;
      }
      case 'setSettings': {
        const q = s.question;
        if (a.autoBuzzer !== undefined) {
          s.settings = { ...s.settings, autoBuzzer: !!a.autoBuzzer };
          if (q?.auto && !q.auto.done) {
            if (s.settings.autoBuzzer) this.armAuto(q);
            else this.suspendAuto(q);
          }
        }
        if (a.timeoutSec !== undefined) {
          const sec = int(a.timeoutSec);
          if (!TIMEOUT_OPTIONS.includes(sec)) throw new GameError('Недопустимое время ответа');
          s.settings = { ...s.settings, timeoutSec: sec };
          if (q && sec === 0 && q.timeout && !q.timeout.expired) {
            // Disabled mid-question: drop the countdown entirely.
            this.haltTimeout(q);
            delete q.timeout;
          } else if (q && sec > 0 && !q.timeout && q.buzzer.open) {
            this.ensureTimeout(q);
            this.runTimeout(q);
          }
        }
        return this.changed();
      }
      case 'timerPause': {
        const q = this.requireQuestion();
        const t = q.timeout;
        if (!t || t.expired) throw new GameError('Таймер не запущен');
        t.hostPaused = !t.hostPaused;
        if (t.hostPaused) this.haltTimeout(q);
        else this.runTimeout(q);
        return this.changed();
      }
      case 'timerReset': {
        const q = this.requireQuestion();
        const t = q.timeout;
        if (!t || t.expired || q.stage === 'answer') throw new GameError('Таймер не запущен');
        this.haltTimeout(q);
        t.remainingMs = t.totalMs;
        this.runTimeout(q);
        return this.changed();
      }
      case 'setAnswering': {
        const q = this.requireQuestion();
        if (!this.player(a.playerId)) throw new GameError('Игрок не найден');
        if (!['content', 'answering'].includes(q.stage)) throw new GameError('Сейчас нельзя назначить отвечающего');
        this.finishAuto(q);
        if (q.responderId) {
          q.responderId = a.playerId;
        } else {
          q.buzzer.open = false;
          q.buzzer.winnerId = a.playerId;
          q.buzzer.order = [];
          q.stage = 'answering';
          this.haltTimeout(q);
        }
        return this.changed();
      }
      case 'judge':
        return this.judge(!!a.correct);
      case 'closeStakes': {
        const q = this.requireQuestion();
        if (q.stage !== 'stakes') throw new GameError('Ставки уже приняты');
        for (const id of q.participants) {
          const p = this.player(id);
          if (!p) continue;
          if (q.written[id]?.stake === undefined) q.written[id] = { ...q.written[id], stake: p.score > 0 ? 1 : 0 };
        }
        q.stage = 'content';
        return this.changed();
      }
      case 'closeWritten': {
        const q = this.requireQuestion();
        if (q.stage !== 'content') throw new GameError('Приём ответов уже закрыт');
        q.stage = 'review';
        return this.changed();
      }
      case 'judgeWritten':
        return this.judgeWritten(String(a.playerId), !!a.correct);
      case 'revealAnswer': {
        const q = this.requireQuestion();
        if (q.stage === 'intro' || q.stage === 'stakes') throw new GameError('Вопрос ещё не показан');
        this.finishAuto(q);
        this.haltTimeout(q);
        this.clearTimers();
        q.stage = 'answer';
        q.buzzer.open = false;
        return this.changed();
      }
      case 'finishQuestion':
      case 'skipQuestion': {
        // Players always get to see the correct answer before the board comes back.
        const q = this.requireQuestion();
        if (q.stage !== 'answer') {
          this.finishAuto(q);
          this.haltTimeout(q);
          this.clearTimers();
          q.stage = 'answer';
          q.buzzer.open = false;
          // Skip: show the answer briefly, then go back to the board on its own.
          if (a.type === 'skipQuestion') {
            q.returnAt = Date.now() + RETURN_TO_BOARD_MS * this.timerScale;
            this.armReturn(q);
          }
          return this.changed();
        }
        return this.endQuestion(true);
      }
      case 'cancelQuestion':
        return this.endQuestion(false);
      case 'finalRemoveTheme': {
        if (s.phase !== 'final' || !s.final) throw new GameError('Сейчас не финал');
        const t = int(a.theme);
        const themes = this.currentRound()!.themes;
        if (t < 0 || t >= themes.length) throw new GameError('Нет такой темы');
        if (s.final.removed.includes(t)) s.final.removed = s.final.removed.filter((x) => x !== t);
        else if (themes.length - s.final.removed.length > 1) s.final.removed.push(t);
        else throw new GameError('Должна остаться хотя бы одна тема');
        return this.changed();
      }
      case 'finalPlayTheme':
        if (s.phase !== 'final') throw new GameError('Сейчас не финал');
        return this.startQuestion(int(a.theme), 0, true);
      case 'adjustScore': {
        const p = this.player(a.playerId);
        if (!p) throw new GameError('Игрок не найден');
        const d = int(a.delta);
        p.score += d;
        this.event('adjust', p.id, d);
        return this.changed();
      }
      case 'setScore': {
        const p = this.player(a.playerId);
        if (!p) throw new GameError('Игрок не найден');
        const v = int(a.score);
        this.event('adjust', p.id, v - p.score);
        p.score = v;
        return this.changed();
      }
      case 'setChooser':
        s.chooserId = a.playerId && this.player(a.playerId) ? a.playerId : null;
        return this.changed();
      case 'kickPlayer': {
        const id = String(a.playerId);
        s.players = s.players.filter((p) => p.id !== id);
        if (s.chooserId === id) s.chooserId = null;
        const q = s.question;
        if (q) {
          if (q.buzzer.winnerId === id) {
            q.buzzer.winnerId = null;
            if (q.stage === 'answering') q.stage = 'content';
          }
          if (q.responderId === id) q.responderId = null;
          q.participants = q.participants.filter((p) => p !== id);
          delete q.written[id];
        }
        return this.changed();
      }
      case 'togglePause': {
        s.paused = !s.paused;
        const q = s.question;
        if (q && s.paused) {
          q.buzzer.reopenAfterPause = q.buzzer.open;
          q.buzzer.open = false;
          this.haltTimeout(q);
          if (this.returnTimer) clearTimeout(this.returnTimer);
          this.returnTimer = null;
        } else if (q) {
          // Restore an open buzzer (and its countdown) after the pause.
          if (q.buzzer.reopenAfterPause && q.stage === 'content') this.openBuzzer(q);
          q.buzzer.reopenAfterPause = false;
          if (q.returnAt) {
            q.returnAt = Date.now() + RETURN_TO_BOARD_MS * this.timerScale;
            this.armReturn(q);
          }
        }
        // The activation countdown freezes during a pause and continues afterwards.
        if (q?.auto && !q.auto.done) {
          if (s.paused) this.suspendAuto(q);
          else this.armAuto(q);
        }
        return this.changed();
      }
      case 'endGame':
        this.clearAuto();
        this.clearTimers();
        s.question = null;
        s.phase = 'gameOver';
        s.paused = false;
        return this.changed();
      case 'resetGame':
        this.clearAuto();
        this.clearTimers();
        for (const p of s.players) p.score = 0;
        s.phase = 'lobby';
        s.roundIndex = 0;
        s.used = [];
        s.question = null;
        s.final = null;
        s.chooserId = null;
        s.paused = false;
        s.lastEvent = null;
        s.lastAnswer = null;
        return this.changed();
      default:
        throw new GameError('Неизвестное действие');
    }
  }

  private setRound(index: number) {
    const pkg = this.requirePkg();
    if (index < 0 || index >= pkg.rounds.length) throw new GameError('Нет такого раунда');
    const s = this.state;
    this.clearAuto();
    this.clearTimers();
    s.roundIndex = index;
    s.question = null;
    s.paused = false;
    const round = pkg.rounds[index];
    if (round.type === 'final') {
      s.phase = 'final';
      // Themes without questions cannot be played — pre-remove them.
      const removed = round.themes.map((t, i) => (t.questions.length === 0 ? i : -1)).filter((i) => i >= 0);
      s.final = { removed: removed.length === round.themes.length ? [] : removed };
    } else {
      s.phase = 'board';
      s.final = null;
    }
    this.changed();
  }

  private startQuestion(t: number, qi: number, fromFinal: boolean) {
    const s = this.state;
    const round = this.currentRound();
    const pq = round?.themes[t]?.questions[qi];
    if (!pq) throw new GameError('Нет такого вопроса');
    if (!fromFinal && (s.used.includes(qKey(s.roundIndex, t, qi)) || pq.price < 0)) throw new GameError('Вопрос уже сыгран');
    const everyone = s.players.map((p) => p.id);
    const q: ActiveQuestion = {
      round: s.roundIndex,
      theme: t,
      question: qi,
      price: pq.price,
      stage: 'content',
      responderId: null,
      buzzer: { open: false, session: 0, winnerId: null, blocked: [], order: [], falseStarts: [] },
      answered: [],
      participants: WRITTEN_TYPES.includes(pq.type) ? everyone : [],
      written: {},
      fromFinal,
    };
    if (RESPONDER_TYPES.includes(pq.type)) q.stage = 'intro';
    if (pq.type === 'stakeAll') q.stage = 'stakes';
    this.locks.clear();
    s.question = q;
    s.phase = 'question';
    this.clearAuto();
    this.clearTimers();
    // Classic buzzer questions get an automatic activation, planned once here on the server.
    if (q.stage === 'content' && pq.type !== 'forAll') {
      q.auto = planAutoBuzzer(pq);
      this.armAuto(q);
    }
    this.changed();
  }

  // ---------- automatic buzzer activation ----------

  private clearAuto() {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  /** Starts (or resumes) the countdown for the current question if auto activation applies. */
  private armAuto(q: ActiveQuestion) {
    const a = q.auto;
    const s = this.state;
    this.clearAuto();
    if (!a || a.done || !s.settings.autoBuzzer || s.paused || s.question !== q) return;
    if (a.waitingForMedia) {
      // Fallback for when the host never reports playback (muted host, blocked autoplay).
      this.autoTimer = setTimeout(() => {
        if (s.question === q && a.waitingForMedia && !a.done) {
          a.waitingForMedia = false;
          this.armAuto(q);
          this.changed();
        }
      }, AUTO_BUZZER.mediaStartFallbackMs);
      return;
    }
    if (a.activateAt === null) {
      a.activateAt = Date.now() + (a.remainingMs ?? a.delayMs);
      a.remainingMs = null;
    }
    this.autoTimer = setTimeout(() => this.fireAuto(q), Math.max(0, a.activateAt - Date.now()));
  }

  private fireAuto(q: ActiveQuestion) {
    this.autoTimer = null;
    const s = this.state;
    if (s.question !== q || !q.auto || q.auto.done || s.paused || !s.settings.autoBuzzer) return;
    q.auto.done = true;
    q.auto.activateAt = null;
    if (q.stage === 'content' && q.buzzer.session === 0 && !q.buzzer.open) this.openBuzzer(q);
    else this.changed();
  }

  /** Freezes a running countdown (pause / auto disabled). */
  private suspendAuto(q: ActiveQuestion) {
    this.clearAuto();
    const a = q.auto;
    if (a && a.activateAt !== null) {
      a.remainingMs = Math.max(0, a.activateAt - Date.now());
      a.activateAt = null;
    }
  }

  private autoView(q: ActiveQuestion): NonNullable<QuestionViewData['auto']> {
    const a = q.auto!;
    const s = this.state;
    const base = { delayMs: a.delayMs, media: a.media };
    if (a.done) return { ...base, mode: 'done' };
    if (!s.settings.autoBuzzer) return { ...base, mode: 'off' };
    if (s.paused) return { ...base, mode: 'paused', remainingMs: a.remainingMs ?? a.delayMs };
    if (a.waitingForMedia) return { ...base, mode: 'waitingMedia' };
    return { ...base, mode: 'counting', remainingMs: Math.max(0, (a.activateAt ?? Date.now()) - Date.now()) };
  }

  /** Manual host action supersedes the automatic activation. */
  private finishAuto(q: ActiveQuestion) {
    this.clearAuto();
    if (q.auto) {
      q.auto.done = true;
      q.auto.activateAt = null;
    }
  }

  private openBuzzer(q: ActiveQuestion) {
    q.stage = 'content';
    q.buzzer.open = true;
    q.buzzer.session++;
    q.buzzer.winnerId = null;
    q.buzzer.order = [];
    this.buzzOpenedAt = performance.now();
    // The no-answer countdown starts when the buzzer becomes active and resumes on reopen.
    this.ensureTimeout(q);
    this.runTimeout(q);
    this.changed();
  }

  // ---------- no-answer timeout ----------

  private clearTimers() {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.timeoutTimer = null;
    this.returnTimer = null;
  }

  private ensureTimeout(q: ActiveQuestion) {
    const sec = this.state.settings.timeoutSec;
    if (q.timeout || sec <= 0) return;
    const totalMs = Math.round(sec * 1000 * this.timerScale);
    q.timeout = { totalMs, remainingMs: totalMs, endsAt: null, hostPaused: false, expired: false };
  }

  /** Runs the countdown if the buzzer is open and nothing pauses it. */
  private runTimeout(q: ActiveQuestion) {
    const s = this.state;
    const t = q.timeout;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    if (!t || t.expired || t.hostPaused || s.paused || s.question !== q || !q.buzzer.open || q.stage !== 'content') return;
    if (t.endsAt === null) t.endsAt = Date.now() + t.remainingMs;
    this.timeoutTimer = setTimeout(() => this.expireTimeout(q), Math.max(0, t.endsAt - Date.now()));
  }

  /** Stops the countdown, keeping the remaining time. */
  private haltTimeout(q: ActiveQuestion) {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    const t = q.timeout;
    if (t && t.endsAt !== null) {
      t.remainingMs = Math.max(0, t.endsAt - Date.now());
      t.endsAt = null;
    }
  }

  private expireTimeout(q: ActiveQuestion) {
    this.timeoutTimer = null;
    const s = this.state;
    const t = q.timeout;
    // Guards make a late or duplicate firing harmless.
    if (s.question !== q || !t || t.expired || q.stage !== 'content' || !q.buzzer.open || q.buzzer.winnerId || s.paused || t.hostPaused) return;
    t.expired = true;
    t.endsAt = null;
    t.remainingMs = 0;
    // Nobody pressed in time: no score changes, show the answer, then go back to the board.
    q.unanswered = true;
    this.finishAuto(q);
    q.buzzer.open = false;
    q.stage = 'answer';
    q.returnAt = Date.now() + RETURN_TO_BOARD_MS * this.timerScale;
    this.armReturn(q);
    this.changed();
  }

  private armReturn(q: ActiveQuestion) {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = null;
    const s = this.state;
    if (!q.returnAt || s.paused) return;
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      if (s.question === q && q.stage === 'answer' && q.returnAt && !s.paused) this.endQuestion(true);
    }, Math.max(0, q.returnAt - Date.now()));
  }

  private assignResponder(playerId: string, price: number) {
    const q = this.requireQuestion();
    const pq = this.pkgQuestion(q);
    if (q.stage !== 'intro') throw new GameError('Отвечающий уже назначен');
    const p = this.player(playerId);
    if (!p) throw new GameError('Игрок не найден');
    let value = price;
    if (pq.type === 'noRisk') value = price > 0 ? price : pq.price * 2;
    if (pq.type === 'stake' && value <= 0) value = pq.price;
    if (value < 0) throw new GameError('Некорректная стоимость');
    q.price = value;
    q.responderId = p.id;
    if (pq.type === 'secretNoQuestion') {
      p.score += value;
      q.answered.push({ playerId: p.id, correct: true, delta: value });
      this.event('correct', p.id, value);
      q.stage = 'answer';
    } else {
      q.stage = 'content';
    }
    this.changed();
  }

  private judge(correct: boolean) {
    const s = this.state;
    const q = this.requireQuestion();
    const pq = this.pkgQuestion(q);
    let playerId: string | null = null;
    if (q.responderId && q.stage === 'content') playerId = q.responderId;
    else if (q.stage === 'answering') playerId = q.buzzer.winnerId;
    const p = this.player(playerId);
    if (!p) throw new GameError('Нет отвечающего игрока');
    const delta = correct ? q.price : pq.type === 'noRisk' ? 0 : -q.price;
    p.score += delta;
    q.answered.push({ playerId: p.id, correct, delta });
    this.event(correct ? 'correct' : 'wrong', p.id, delta);
    if (correct) {
      s.chooserId = p.id;
      q.stage = 'answer';
    } else if (q.responderId) {
      q.stage = 'answer';
    } else {
      q.buzzer.blocked.push(p.id);
      q.buzzer.winnerId = null;
      q.buzzer.open = false;
      q.buzzer.falseStarts = [];
      if (s.players.every((x) => q.buzzer.blocked.includes(x.id))) {
        // Everyone has tried — nothing left to buzz for, show the answer.
        q.stage = 'answer';
        this.clearTimers();
        if (q.timeout) {
          q.returnAt = Date.now() + RETURN_TO_BOARD_MS * this.timerScale;
          this.armReturn(q);
        }
      } else {
        q.stage = 'content';
        // Reopen for the remaining players; the countdown resumes with the time that was left.
        if (q.timeout || s.settings.autoBuzzer) return this.openBuzzer(q);
      }
    }
    this.changed();
  }

  private judgeWritten(playerId: string, correct: boolean) {
    const q = this.requireQuestion();
    const pq = this.pkgQuestion(q);
    if (!WRITTEN_TYPES.includes(pq.type)) throw new GameError('Это не вопрос с письменными ответами');
    if (q.stage !== 'review' && q.stage !== 'answer') throw new GameError('Сначала закройте приём ответов');
    const p = this.player(playerId);
    if (!p || !q.participants.includes(playerId)) throw new GameError('Игрок не участвует');
    const entry = (q.written[playerId] ??= {});
    const amount = pq.type === 'stakeAll' ? (entry.stake ?? 0) : q.price;
    // Revert previous verdict so the host can change their mind.
    if (entry.verdict === true) p.score -= amount;
    if (entry.verdict === false) p.score += amount;
    entry.verdict = correct;
    const delta = correct ? amount : -amount;
    p.score += delta;
    q.answered = q.answered.filter((x) => x.playerId !== playerId);
    q.answered.push({ playerId, correct, delta });
    this.event(correct ? 'correct' : 'wrong', playerId, delta);
    this.changed();
  }

  private endQuestion(markUsed: boolean) {
    const s = this.state;
    const q = this.requireQuestion();
    this.clearAuto();
    this.clearTimers();
    if (markUsed) {
      const k = qKey(q.round, q.theme, q.question);
      if (!s.used.includes(k)) s.used.push(k);
    }
    if (q.stage === 'answer') {
      const pq = this.pkgQuestion(q);
      const opt = pq.answerType === 'select' ? pq.options?.find((o) => o.label === pq.right[0]) : undefined;
      const optText = opt?.content.map((c) => c.text).filter(Boolean).join(' ');
      s.lastAnswer = {
        themeName: this.pkg!.rounds[q.round].themes[q.theme].name,
        price: q.price,
        text: opt ? `${opt.label}: ${optText}` : (pq.right[0] ?? '—'),
      };
    }
    s.question = null;
    if (q.fromFinal) {
      if (!markUsed) {
        s.phase = 'final';
      } else if (this.pkg && s.roundIndex + 1 < this.pkg.rounds.length) {
        return this.setRound(s.roundIndex + 1);
      } else {
        s.phase = 'gameOver';
      }
    } else {
      s.phase = 'board';
    }
    this.changed();
  }

  // ---------- helpers ----------

  private requirePkg(): Package {
    if (!this.pkg) throw new GameError('Пакет не загружен');
    return this.pkg;
  }

  private requireQuestion(): ActiveQuestion {
    if (!this.state.question) throw new GameError('Нет активного вопроса');
    return this.state.question;
  }

  private currentRound() {
    return this.pkg?.rounds[this.state.roundIndex];
  }

  private pkgQuestion(q: ActiveQuestion): PkgQuestion {
    const pq = this.pkg?.rounds[q.round]?.themes[q.theme]?.questions[q.question];
    if (!pq) throw new GameError('Вопрос не найден в пакете');
    return pq;
  }

  // ---------- views ----------

  private content(items: PkgContentItem[]): ContentView[] {
    const pkgId = this.pkg?.id;
    return items.map((it) => ({
      kind: it.kind,
      text: it.text,
      url: it.mediaId ? `/media/${pkgId}/${it.mediaId}` : it.url,
      placement: it.placement,
      name: it.missing ? it.name : undefined,
      missing: it.missing,
    }));
  }

  /** Builds the view for a client. Hidden information never leaves the server for non-hosts. */
  view(role: 'host' | 'player' | 'screen', playerId?: string): GameView {
    const s = this.state;
    const pkg = this.pkg;
    const isHost = role === 'host';
    const round = pkg?.rounds[s.roundIndex];
    const me = role === 'player' ? this.player(playerId) : undefined;

    let board: GameView['board'] = null;
    if (round && s.phase !== 'lobby') {
      let remaining = 0;
      board = {
        name: round.name,
        type: round.type,
        themes: round.themes.map((t, ti) => ({
          name: t.name,
          questions: t.questions.map((q, qi) => {
            const used = s.used.includes(qKey(s.roundIndex, ti, qi));
            const empty = q.price < 0;
            if (!used && !empty) remaining++;
            return { price: q.price, used, empty };
          }),
        })),
        remaining,
      };
    }

    let question: QuestionViewData | null = null;
    const q = s.question;
    if (q && pkg) {
      const pq = this.pkgQuestion(q);
      const theme = pkg.rounds[q.round].themes[q.theme];
      const showContent = q.stage !== 'intro' && q.stage !== 'stakes';
      const revealed = q.stage === 'answer';
      const written = WRITTEN_TYPES.includes(pq.type);
      let writtenView: WrittenView[] | null = null;
      if (written) {
        writtenView = q.participants
          .filter((id) => this.player(id))
          .map((id) => {
            const w = q.written[id] ?? {};
            const visible = isHost || revealed || (q.stage === 'review' && w.verdict !== undefined && w.verdict !== null);
            return {
              playerId: id,
              submitted: !!w.text,
              stakeSubmitted: w.stake !== undefined,
              text: visible ? w.text : undefined,
              stake: visible ? w.stake : undefined,
              verdict: visible ? (w.verdict ?? null) : undefined,
            };
          });
      }
      const correctOption =
        pq.answerType === 'select' && pq.options?.some((o) => o.label === pq.right[0]) ? pq.right[0] : undefined;
      question = {
        themeName: theme.name,
        price: q.price,
        type: pq.type,
        stage: q.stage,
        responderId: q.responderId,
        content: showContent || isHost ? this.content(pq.question) : null,
        options: (showContent || isHost) && pq.options ? pq.options.map((o) => ({ label: o.label, content: this.content(o.content) })) : null,
        answerType: pq.answerType,
        answer: revealed || isHost ? { content: this.content(pq.answer), right: pq.right, wrong: pq.wrong, correctOption } : null,
        comment: isHost || revealed ? pq.comment : undefined,
        secretTheme: pq.secretTheme,
        secretPrices: pq.secretPrices,
        buzzer: {
          open: q.buzzer.open,
          winnerId: q.buzzer.winnerId,
          blocked: q.buzzer.blocked,
          order: q.buzzer.order,
          falseStarts: q.buzzer.falseStarts ?? [],
        },
        myLockMs: me ? this.lockMsFor(me.id) : undefined,
        auto: isHost && q.auto ? this.autoView(q) : undefined,
        timer: q.timeout
          ? {
              totalMs: q.timeout.totalMs,
              remainingMs: q.timeout.endsAt !== null ? Math.max(0, q.timeout.endsAt - Date.now()) : q.timeout.remainingMs,
              running: q.timeout.endsAt !== null,
              paused: q.timeout.hostPaused || s.paused,
              expired: q.timeout.expired,
            }
          : null,
        unanswered: q.unanswered,
        returnMs: q.returnAt ? Math.max(0, q.returnAt - Date.now()) : undefined,
        answered: q.answered,
        written: writtenView,
      };
      if (me && written) {
        const w = q.written[me.id] ?? {};
        const participant = q.participants.includes(me.id);
        question.mine = {
          text: w.text,
          stake: w.stake,
          canAnswer: participant && q.stage === 'content',
          maxStake: participant && q.stage === 'stakes' ? Math.max(me.score, 0) : 0,
        };
      }
    }

    return {
      role,
      me: me ? { id: me.id, name: me.name, score: me.score } : undefined,
      pkg: pkg
        ? {
            id: pkg.id,
            name: pkg.name,
            author: pkg.author,
            logoUrl: pkg.logoMediaId ? `/media/${pkg.id}/${pkg.logoMediaId}` : undefined,
            rounds: pkg.rounds.map((r) => ({ name: r.name, type: r.type })),
          }
        : null,
      phase: s.phase,
      paused: s.paused,
      roundIndex: s.roundIndex,
      board,
      players: s.players.map((p) => ({ id: p.id, name: p.name, score: p.score, online: this.online.has(p.id) })),
      chooserId: s.chooserId,
      question,
      final:
        s.phase === 'final' && round && s.final
          ? { stage: 'themes', themes: round.themes.map((t, i) => ({ name: t.name, removed: s.final!.removed.includes(i) })) }
          : null,
      lastEvent: s.lastEvent,
      lastAnswer: s.phase === 'board' ? s.lastAnswer : null,
      settings: isHost ? s.settings : undefined,
    };
  }
}

function int(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new GameError('Некорректное число');
  return n;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
