import { sameTurn } from './generation';
import type { TurnRef } from './providers/tts';

export type TurnManagerTimerHandle = number | object;

/**
 * Injectable time boundary. Tests can advance this clock without sleeping.
 */
export interface TurnManagerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TurnManagerTimerHandle;
  clearTimeout(handle: TurnManagerTimerHandle): void;
}

export type TurnCancellationReason =
  | 'barge-in'
  | 'empty-transcript'
  | 'manual'
  | 'disposed';

export type TurnLease = Readonly<{
  turn: TurnRef;
  /**
   * The same signal must be passed to every LLM and TTS task for this turn.
   */
  signal: AbortSignal;
}>;

export type UserTurnStartedEvent = Readonly<{
  type: 'user_turn_started';
  turn: TurnRef;
  signal: AbortSignal;
  timestampMs: number;
}>;

export type UserTurnCommittedEvent = Readonly<{
  type: 'user_turn_committed';
  turn: TurnRef;
  signal: AbortSignal;
  transcript: string;
  transcriptIsFinal: boolean;
  timestampMs: number;
}>;

export type BargeInEvent = Readonly<{
  type: 'barge_in';
  interruptedTurn: TurnRef;
  nextTurn: TurnRef;
  timestampMs: number;
}>;

export type TurnCancelledEvent = Readonly<{
  type: 'cancelled';
  turn: TurnRef;
  phase: 'collecting' | 'committed';
  reason: TurnCancellationReason;
  timestampMs: number;
}>;

export type TurnManagerEvent =
  | UserTurnStartedEvent
  | UserTurnCommittedEvent
  | BargeInEvent
  | TurnCancelledEvent;

export type TurnManagerEventHandler = (event: TurnManagerEvent) => void;

export type VadEvent =
  | Readonly<{ type: 'speech_started' }>
  | Readonly<{ type: 'speech_stopped'; turn?: TurnRef }>;

/**
 * `text` is the STT provider's full accumulated transcript for this utterance.
 * Passing `turn` is recommended: delayed results for older turns are then
 * rejected instead of being applied to the current turn.
 */
export type SttTranscriptEvent = Readonly<{
  text: string;
  isFinal: boolean;
  turn?: TurnRef;
}>;

export type TurnManagerOptions = Readonly<{
  callId: string;
  conversationId: string;
  /**
   * Last generation already reserved by the caller (for example, generation
   * 1 for a pre-conversation greeting). User turns start strictly after it.
   */
  initialGeneration?: number;
  endpointingDelayMs?: number;
  clock?: TurnManagerClock;
  createTurnId?: (sequence: number) => string;
  onEvent?: TurnManagerEventHandler;
}>;

export type ActiveTurnSnapshot = TurnLease &
  Readonly<{
    phase: 'collecting' | 'committed';
  }>;

type ActiveTurn = {
  readonly lease: TurnLease;
  readonly controller: AbortController;
  phase: 'collecting' | 'committed';
  vadSpeaking: boolean;
  endpointRequested: boolean;
  transcript: string;
  transcriptIsFinal: boolean;
  endpointTimer?: TurnManagerTimerHandle;
  endpointToken: number;
};

const DEFAULT_ENDPOINTING_DELAY_MS = 300;

const systemClock: TurnManagerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Deterministic state machine for one voice call.
 *
 * State transitions are synchronous. In particular, barge-in installs the next
 * generation and aborts the previous generation before any event is delivered.
 */
export class VoiceTurnManager {
  private readonly callId: string;
  private readonly conversationId: string;
  private readonly endpointingDelayMs: number;
  private readonly clock: TurnManagerClock;
  private readonly createTurnId: (sequence: number) => string;
  private readonly onEvent?: TurnManagerEventHandler;

  private active?: ActiveTurn;
  private turnSequence = 0;
  private generation: number;
  private endpointToken = 0;
  private disposed = false;

  private dispatching = false;
  private readonly eventQueue: TurnManagerEvent[] = [];

  constructor(options: TurnManagerOptions) {
    this.callId = requireIdentifier(options.callId, 'callId');
    this.conversationId = requireIdentifier(
      options.conversationId,
      'conversationId'
    );
    const initialGeneration = options.initialGeneration ?? 0;
    if (
      !Number.isSafeInteger(initialGeneration) ||
      initialGeneration < 0 ||
      initialGeneration >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        'initialGeneration must be a non-negative safe integer below Number.MAX_SAFE_INTEGER'
      );
    }
    this.generation = initialGeneration;
    this.endpointingDelayMs =
      options.endpointingDelayMs ?? DEFAULT_ENDPOINTING_DELAY_MS;

    if (
      !Number.isFinite(this.endpointingDelayMs) ||
      this.endpointingDelayMs < 0
    ) {
      throw new Error('endpointingDelayMs must be a non-negative finite number');
    }

    this.clock = options.clock ?? systemClock;
    this.createTurnId =
      options.createTurnId ?? (sequence => `turn-${sequence}`);
    this.onEvent = options.onEvent;
  }

  get current(): ActiveTurnSnapshot | undefined {
    if (!this.active || this.active.controller.signal.aborted) return undefined;

    return Object.freeze({
      ...this.active.lease,
      phase: this.active.phase,
    });
  }

  handleVad(event: VadEvent): TurnLease | undefined {
    return event.type === 'speech_started'
      ? this.speechStarted()
      : (this.speechStopped(event.turn), this.active?.lease);
  }

  /**
   * Starts a new turn, or resumes the collecting turn during the debounce
   * window. If a committed turn is active this is a barge-in.
   */
  speechStarted(): TurnLease {
    this.assertNotDisposed();

    const existing = this.active;
    if (existing?.phase === 'collecting') {
      existing.vadSpeaking = true;
      existing.endpointRequested = false;
      this.clearEndpointTimer(existing);
      return existing.lease;
    }

    const timestampMs = this.clock.now();
    const next = this.createActiveTurn(true);

    if (!existing) {
      this.active = next;
      this.emit({
        type: 'user_turn_started',
        ...next.lease,
        timestampMs,
      });
      return next.lease;
    }

    this.clearEndpointTimer(existing);
    this.active = next;
    existing.controller.abort('barge-in');

    this.emitMany([
      {
        type: 'barge_in',
        interruptedTurn: existing.lease.turn,
        nextTurn: next.lease.turn,
        timestampMs,
      },
      {
        type: 'cancelled',
        turn: existing.lease.turn,
        phase: existing.phase,
        reason: 'barge-in',
        timestampMs,
      },
      {
        type: 'user_turn_started',
        ...next.lease,
        timestampMs,
      },
    ]);

    return next.lease;
  }

  /**
   * Requests endpointing. A later transcript result or renewed speech resets
   * the timer, so trailing STT results are included.
   */
  speechStopped(turn?: TurnRef): void {
    this.assertNotDisposed();

    const active = this.active;
    if (!active || active.phase !== 'collecting') return;
    if (turn && !sameTurn(turn, active.lease.turn)) return;

    active.vadSpeaking = false;
    active.endpointRequested = true;
    this.scheduleEndpoint(active);
  }

  /**
   * Applies an interim or final STT snapshot to the collecting turn.
   * A final result can endpoint a transcript-only flow even without VAD.
   */
  handleTranscript(event: SttTranscriptEvent): TurnLease | undefined {
    this.assertNotDisposed();

    const text = event.text.trim();
    if (!text) return this.active?.lease;

    let active = this.active;
    if (!active) {
      if (event.turn) return undefined;

      active = this.createActiveTurn(false);
      this.active = active;
      this.emit({
        type: 'user_turn_started',
        ...active.lease,
        timestampMs: this.clock.now(),
      });
    }

    if (active.phase !== 'collecting') return undefined;
    if (event.turn && !sameTurn(event.turn, active.lease.turn)) {
      return undefined;
    }

    active.transcript = text;
    active.transcriptIsFinal = event.isFinal;

    if (
      !active.vadSpeaking &&
      (active.endpointRequested || event.isFinal)
    ) {
      active.endpointRequested = true;
      this.scheduleEndpoint(active);
    }

    return active.lease;
  }

  /**
   * Marks downstream work as done. It does not abort the completed signal.
   */
  complete(turn: TurnRef): boolean {
    const active = this.active;
    if (
      !active ||
      active.phase !== 'committed' ||
      !sameTurn(active.lease.turn, turn)
    ) {
      return false;
    }

    this.clearEndpointTimer(active);
    this.active = undefined;
    return true;
  }

  cancel(
    turn: TurnRef,
    reason: TurnCancellationReason = 'manual'
  ): boolean {
    const active = this.active;
    if (!active || !sameTurn(active.lease.turn, turn)) return false;

    this.cancelActive(active, reason);
    return true;
  }

  /**
   * Returns false for every callback belonging to an invalidated generation.
   */
  isCurrent(turn: TurnRef): boolean {
    return Boolean(
      this.active &&
        !this.active.controller.signal.aborted &&
        sameTurn(this.active.lease.turn, turn)
    );
  }

  /**
   * Wrap LLM/TTS callbacks with this helper to suppress stale chunks.
   */
  guard<TArgs extends unknown[], TResult>(
    turn: TurnRef,
    callback: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult | undefined {
    return (...args) =>
      this.isCurrent(turn) ? callback(...args) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    const active = this.active;
    if (active) this.cancelActive(active, 'disposed');
  }

  private createActiveTurn(vadSpeaking: boolean): ActiveTurn {
    const sequence = ++this.turnSequence;
    const turnId = requireIdentifier(
      this.createTurnId(sequence),
      'createTurnId result'
    );
    const controller = new AbortController();
    const turn: TurnRef = Object.freeze({
      callId: this.callId,
      conversationId: this.conversationId,
      turnId,
      generation: ++this.generation,
    });
    const lease: TurnLease = Object.freeze({
      turn,
      signal: controller.signal,
    });

    return {
      lease,
      controller,
      phase: 'collecting',
      vadSpeaking,
      endpointRequested: false,
      transcript: '',
      transcriptIsFinal: false,
      endpointToken: 0,
    };
  }

  private scheduleEndpoint(active: ActiveTurn): void {
    this.clearEndpointTimer(active);

    const token = ++this.endpointToken;
    active.endpointToken = token;
    active.endpointTimer = this.clock.setTimeout(() => {
      this.commitAtEndpoint(active, token);
    }, this.endpointingDelayMs);
  }

  private commitAtEndpoint(active: ActiveTurn, token: number): void {
    if (
      this.disposed ||
      this.active !== active ||
      active.phase !== 'collecting' ||
      active.vadSpeaking ||
      !active.endpointRequested ||
      active.endpointToken !== token
    ) {
      return;
    }

    active.endpointTimer = undefined;
    const transcript = active.transcript.trim();
    if (!transcript) {
      this.cancelActive(active, 'empty-transcript');
      return;
    }

    active.phase = 'committed';
    active.endpointRequested = false;
    this.emit({
      type: 'user_turn_committed',
      ...active.lease,
      transcript,
      transcriptIsFinal: active.transcriptIsFinal,
      timestampMs: this.clock.now(),
    });
  }

  private cancelActive(
    active: ActiveTurn,
    reason: TurnCancellationReason
  ): void {
    const timestampMs = this.clock.now();
    const phase = active.phase;

    this.clearEndpointTimer(active);
    if (this.active === active) this.active = undefined;
    active.controller.abort(reason);

    this.emit({
      type: 'cancelled',
      turn: active.lease.turn,
      phase,
      reason,
      timestampMs,
    });
  }

  private clearEndpointTimer(active: ActiveTurn): void {
    if (active.endpointTimer !== undefined) {
      this.clock.clearTimeout(active.endpointTimer);
      active.endpointTimer = undefined;
    }

    active.endpointToken = ++this.endpointToken;
  }

  private emitMany(events: readonly TurnManagerEvent[]): void {
    for (const event of events) this.eventQueue.push(Object.freeze(event));
    this.drainEvents();
  }

  private emit(event: TurnManagerEvent): void {
    this.eventQueue.push(Object.freeze(event));
    this.drainEvents();
  }

  private drainEvents(): void {
    if (!this.onEvent) {
      this.eventQueue.length = 0;
      return;
    }
    if (this.dispatching) return;

    this.dispatching = true;
    try {
      let event: TurnManagerEvent | undefined;
      while ((event = this.eventQueue.shift())) this.onEvent(event);
    } finally {
      this.dispatching = false;
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('VoiceTurnManager is disposed');
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
