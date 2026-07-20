import type { VoiceRuntimeEvent } from '../runtime';
import { VoximplantProtocolError } from './voximplant-media';

export type VoiceChannelFrame = Readonly<{
  data: Buffer | string;
  isBinary: boolean;
}>;

export type VoiceWebSocketLike = Readonly<{
  readyState: number;
  bufferedAmount: number;
  send: (
    data: Buffer | string,
    options: { binary: boolean },
    callback: (error?: Error) => void
  ) => void;
  close: (code: number, reason: string) => void;
  terminate: () => void;
}>;

export type BoundedVoiceWebSocketSenderOptions = Readonly<{
  socket: VoiceWebSocketLike;
  openState: number;
  maxBufferedBytes: number;
  onSendError?: (error: Error) => void;
}>;

/**
 * Converts WebSocket backpressure into an explicit call failure. Audio must
 * never be silently discarded while the socket still reports itself open.
 */
export function createBoundedVoiceWebSocketSender(
  options: BoundedVoiceWebSocketSenderOptions
): (data: Buffer | string) => void {
  if (
    !Number.isSafeInteger(options.maxBufferedBytes) ||
    options.maxBufferedBytes <= 0
  ) {
    throw new Error('maxBufferedBytes must be a positive safe integer');
  }

  return data => {
    if (options.socket.readyState !== options.openState) return;

    const frameBytes =
      typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    if (
      options.socket.bufferedAmount + frameBytes >
      options.maxBufferedBytes
    ) {
      options.socket.close(1011, 'Voice transport backpressure');
      throw new VoximplantProtocolError(
        'backpressure',
        'Voice WebSocket outbound buffer exceeded its limit'
      );
    }

    options.socket.send(
      data,
      { binary: Buffer.isBuffer(data) },
      error => {
        if (!error) return;
        options.onSendError?.(error);
        options.socket.terminate();
      }
    );
  };
}

/**
 * Rejects events belonging to a generation that has already been superseded.
 */
export class VoiceEventGenerationGate {
  private latestGeneration = 0;

  accept(event: VoiceRuntimeEvent): boolean {
    const generation = voiceEventGeneration(event);
    if (generation === undefined) return true;
    if (generation < this.latestGeneration) return false;
    this.latestGeneration = generation;
    return true;
  }

  get currentGeneration(): number {
    return this.latestGeneration;
  }
}

export function voiceEventGeneration(
  event: VoiceRuntimeEvent
): number | undefined {
  if (
    event.type === 'audio' ||
    event.type === 'fallback_speech' ||
    event.type === 'metric'
  ) {
    return event.generation;
  }
  if (event.type === 'playback_clear') return event.generation;
  if (event.type === 'playback_flush') return event.generation;
  if (event.type === 'transcript') return event.turn?.generation;
  return undefined;
}

type FinalTranscriptEvent = Extract<
  VoiceRuntimeEvent,
  { type: 'transcript' }
>;

export type FinalTranscriptDeliveryOptions = Readonly<{
  event: FinalTranscriptEvent;
  transcript: string[];
  finishPlayback: () => void;
  persist: (
    role: 'user' | 'assistant',
    text: string
  ) => Promise<void>;
  onPersistenceError?: (
    error: unknown,
    role: 'user' | 'assistant'
  ) => void;
}>;

/**
 * Flushes speech before awaiting storage and makes transcript persistence
 * best-effort, so a database outage cannot suppress already generated audio.
 */
export async function deliverFinalTranscript(
  options: FinalTranscriptDeliveryOptions
): Promise<boolean> {
  if (!options.event.isFinal) return false;

  const role = options.event.role ?? 'assistant';
  options.transcript.push(`${role}: ${options.event.text}`);
  if (role === 'assistant' && !options.event.turn) {
    options.finishPlayback();
  }

  try {
    await options.persist(role, options.event.text);
  } catch (error) {
    options.onPersistenceError?.(error, role);
  }
  return true;
}

export type SerializedStartupFrameRouterOptions<T> = Readonly<{
  maxQueuedBytes: number;
  byteLength: (frame: T) => number;
  onFailure: (error: unknown) => void;
}>;

/**
 * Serializes frames received while the session is being initialized. Frames
 * arriving during the drain are chained after it, preserving wire order.
 */
export class SerializedStartupFrameRouter<T> {
  private readonly queuedFrames: T[] = [];
  private queuedBytes = 0;
  private handler: ((frame: T) => Promise<void>) | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: SerializedStartupFrameRouterOptions<T>
  ) {
    if (
      !Number.isSafeInteger(options.maxQueuedBytes) ||
      options.maxQueuedBytes <= 0
    ) {
      throw new Error('maxQueuedBytes must be a positive safe integer');
    }
  }

  enqueue(frame: T): void {
    this.chain = this.chain
      .then(async () => {
        if (this.handler) {
          await this.handler(frame);
          return;
        }

        const frameBytes = this.options.byteLength(frame);
        if (
          !Number.isSafeInteger(frameBytes) ||
          frameBytes < 0 ||
          this.queuedBytes + frameBytes > this.options.maxQueuedBytes
        ) {
          throw new VoximplantProtocolError(
            'payload_too_large',
            'Voice startup queue exceeded its configured limit'
          );
        }
        this.queuedFrames.push(frame);
        this.queuedBytes += frameBytes;
      })
      .catch(error => {
        this.options.onFailure(error);
      });
  }

  activate(handler: (frame: T) => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        this.handler = handler;
        const startupFrames = this.queuedFrames.splice(0);
        this.queuedBytes = 0;
        for (const frame of startupFrames) {
          await handler(frame);
        }
      })
      .catch(error => {
        this.options.onFailure(error);
      });
    return this.chain;
  }

  idle(): Promise<void> {
    return this.chain;
  }
}

export function voiceChannelFrameByteLength(
  frame: VoiceChannelFrame
): number {
  return typeof frame.data === 'string'
    ? Buffer.byteLength(frame.data)
    : frame.data.length;
}

/**
 * Tracks both an initialization reservation and a provisionally registered
 * session. Taking a session is idempotent, including an early close before the
 * provisional value exists.
 */
export class ProvisionalVoiceSessionRegistry<T> {
  private readonly sessions = new Map<string, T>();
  private readonly initializing = new Set<string>();
  private readonly cancelledInitializations = new Set<string>();
  private accepting = true;

  tryReserve(sessionId: string): boolean {
    if (
      !this.accepting ||
      this.initializing.has(sessionId) ||
      this.sessions.has(sessionId)
    ) {
      return false;
    }
    this.initializing.add(sessionId);
    return true;
  }

  register(sessionId: string, session: T): boolean {
    if (!this.initializing.has(sessionId)) {
      throw new Error('Voice session must be reserved before registration');
    }
    if (this.sessions.has(sessionId)) {
      throw new Error('Voice session is already registered');
    }
    this.sessions.set(sessionId, session);
    return !this.cancelledInitializations.has(sessionId);
  }

  finishInitialization(sessionId: string): void {
    this.initializing.delete(sessionId);
    if (!this.sessions.has(sessionId)) {
      this.cancelledInitializations.delete(sessionId);
    }
  }

  get(sessionId: string): T | undefined {
    if (this.cancelledInitializations.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  take(sessionId: string): T | undefined {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (this.initializing.has(sessionId)) {
      this.cancelledInitializations.add(sessionId);
    } else {
      this.cancelledInitializations.delete(sessionId);
    }
    return session;
  }

  /**
   * Atomically stops new reservations and marks every in-progress
   * initialization as cancelled. A cancelled initialization may still
   * provisionally register its value so its caller can run normal cleanup,
   * but register() returns false and get() keeps it hidden from activation.
   * The returned IDs are fully initialized sessions that are safe to finalize
   * immediately; cancelled initializations finalize themselves at a safe
   * initialization boundary.
   */
  beginShutdown(): string[] {
    this.accepting = false;
    for (const sessionId of this.initializing) {
      this.cancelledInitializations.add(sessionId);
    }
    return [...this.sessions.keys()].filter(
      sessionId => !this.initializing.has(sessionId)
    );
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  get initializingCount(): number {
    return this.initializing.size;
  }
}

export type VoiceSessionDrainResult = Readonly<{
  drained: boolean;
  pendingCount: number;
}>;

/**
 * Tracks initialization and finalization work even after a session has been
 * removed from the registry. drain() also observes work added while it is
 * waiting, which covers cleanup spawned by a cancelled initialization.
 */
export class VoiceSessionDrainTracker {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly keyedWork = new Map<string, Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = work.finally(() => {
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
    return tracked;
  }

  /**
   * Starts at most one operation for a key and returns that exact in-flight
   * promise to every concurrent caller.
   */
  getRunning<T>(key: string): Promise<T> | undefined {
    return this.keyedWork.get(key) as Promise<T> | undefined;
  }

  runOnce<T>(key: string, create: () => Promise<T>): Promise<T> {
    const existing = this.getRunning<T>(key);
    if (existing) return existing;

    const tracked = this.track(Promise.resolve().then(create));
    this.keyedWork.set(key, tracked);
    const forget = (): void => {
      if (this.keyedWork.get(key) === tracked) {
        this.keyedWork.delete(key);
      }
    };
    void tracked.then(forget, forget);
    return tracked;
  }

  async drain(timeoutMs: number): Promise<VoiceSessionDrainResult> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0
    ) {
      throw new Error(
        'Voice session drain timeout must be a non-negative safe integer'
      );
    }

    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          drained: false,
          pendingCount: this.pending.size,
        };
      }

      const settledBeforeDeadline = await waitForVoiceSessionWork(
        [...this.pending],
        remainingMs
      );
      if (!settledBeforeDeadline) {
        return {
          drained: false,
          pendingCount: this.pending.size,
        };
      }
    }

    return { drained: true, pendingCount: 0 };
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

function waitForVoiceSessionWork(
  work: Promise<unknown>[],
  timeoutMs: number
): Promise<boolean> {
  return new Promise(resolve => {
    let finished = false;
    const finish = (settled: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void Promise.allSettled(work).then(() => finish(true));
  });
}
