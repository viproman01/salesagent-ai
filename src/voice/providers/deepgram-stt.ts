import { randomUUID } from 'crypto';
import type { ClientRequest, IncomingMessage } from 'http';
import WebSocket, {
  type ClientOptions as WebSocketClientOptions,
  type RawData,
} from 'ws';
import {
  SttProviderError,
  type StreamingSttProvider,
  type StreamingSttSession,
  type SttAudioFormat,
  type SttSessionEvent,
  type SttSessionOptions,
  type SttSessionState,
  type SttTerminal,
  type SttTurnEventKind,
  type SttTurnSnapshot,
  type SttWord,
} from './stt';

const DEFAULT_URL = 'wss://api.deepgram.com/v2/listen';
const DEFAULT_MODEL = 'flux-general-multi';
const WIRE_FRAME_BYTES = 640;
const SUPPORTED_FLUX_LANGUAGE_BASES = new Set([
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'it',
  'ja',
  'nl',
  'pt',
  'ru',
]);

export type DeepgramWebSocketFactory = (
  url: string,
  options: WebSocketClientOptions
) => WebSocket;

export type DeepgramSttEventHandlerErrorContext = Readonly<{
  provider: 'deepgram-flux';
  eventType: SttSessionEvent['type'];
  transcriptionId: string;
  attemptId: string;
}>;

export type DeepgramFluxSttProviderOptions = Readonly<{
  apiKey: string;
  url?: string;
  allowCustomEndpoint?: boolean;
  model?: 'flux-general-multi';
  languageHints?: readonly string[];
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
  connectTimeoutMs?: number;
  finishTimeoutMs?: number;
  sendTimeoutMs?: number;
  eventHandlerTimeoutMs?: number;
  maxSocketBufferedBytes?: number;
  maxAudioDurationMs?: number;
  maxIncomingFrameBytes?: number;
  maxPendingAudioWrites?: number;
  maxPendingTurnEvents?: number;
  webSocketFactory?: DeepgramWebSocketFactory;
  now?: () => number;
  onEventHandlerError?: (
    error: unknown,
    context: DeepgramSttEventHandlerErrorContext
  ) => void;
}>;

type ResolvedDeepgramOptions = Readonly<{
  url: string;
  model: 'flux-general-multi';
  languageHints: readonly string[];
  eotThreshold: number;
  eagerEotThreshold?: number;
  eotTimeoutMs: number;
  connectTimeoutMs: number;
  finishTimeoutMs: number;
  sendTimeoutMs: number;
  eventHandlerTimeoutMs: number;
  maxSocketBufferedBytes: number;
  maxAudioBytes: number;
  maxIncomingFrameBytes: number;
  maxPendingAudioWrites: number;
  maxPendingTurnEvents: number;
  webSocketFactory: DeepgramWebSocketFactory;
  now: () => number;
  onEventHandlerError: (
    error: unknown,
    context: DeepgramSttEventHandlerErrorContext
  ) => void;
}>;

type ResolvedDeepgramConfiguration = Readonly<{
  apiKey: string;
  options: ResolvedDeepgramOptions;
}>;

type DeepgramConnected = Readonly<{
  type: 'Connected';
  requestId: string;
  sequenceId: number;
}>;

type DeepgramTurnInfo = Readonly<{
  type: 'TurnInfo';
  requestId: string;
  sequenceId: number;
  event: 'Update' | 'StartOfTurn' | 'EndOfTurn' | 'EagerEndOfTurn' | 'TurnResumed';
  turnIndex: number;
  audioWindowStart: number;
  audioWindowEnd: number;
  transcript: string;
  words: readonly SttWord[];
  endOfTurnConfidence: number;
  languages: readonly string[];
  languagesHinted: readonly string[];
}>;

type DeepgramFatalError = Readonly<{
  type: 'Error';
  sequenceId: number;
  code: string;
}>;

type DeepgramServerEvent =
  | DeepgramConnected
  | DeepgramTurnInfo
  | DeepgramFatalError;

export class DeepgramFluxSttProvider implements StreamingSttProvider {
  readonly name = 'deepgram-flux';
  readonly inputFormat: SttAudioFormat = Object.freeze({
    encoding: 'mulaw',
    sampleRateHz: 8000,
    channels: 1,
  });

  readonly #apiKey: string;
  private readonly options: ResolvedDeepgramOptions;

  constructor(options: DeepgramFluxSttProviderOptions) {
    const resolved = resolveOptions(options);
    this.#apiKey = resolved.apiKey;
    this.options = resolved.options;
  }

  async open(options: SttSessionOptions): Promise<StreamingSttSession> {
    validateStream(options.stream);
    if (options.signal.aborted) {
      throw new SttProviderError(
        'invalid_state',
        'STT stream was cancelled before opening',
        false
      );
    }

    let socket: WebSocket;
    try {
      socket = this.options.webSocketFactory(
        buildConnectionUrl(this.options),
        {
          headers: {
            Authorization: `Token ${this.#apiKey}`,
          },
          maxPayload: this.options.maxIncomingFrameBytes,
          perMessageDeflate: false,
        }
      );
    } catch {
      throw new SttProviderError(
        'socket_error',
        'Unable to create Deepgram WebSocket',
        true
      );
    }

    const session = new DeepgramFluxSttSession(
      socket,
      options,
      this.inputFormat,
      this.options
    );
    await session.waitUntilConnected();
    return session;
  }
}

class DeepgramFluxSttSession implements StreamingSttSession {
  readonly provider = 'deepgram-flux';
  readonly transcriptionId = randomUUID();
  readonly attemptId = randomUUID();
  readonly stream: SttSessionOptions['stream'];
  readonly closed: Promise<SttTerminal>;

  private _state: SttSessionState = 'opening';
  private readonly startedAtMs: number;
  private connectedAtMs: number | undefined;
  private requestId: string | undefined;
  private lastServerSequence = -1;
  private pendingAudio: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private audioBytes = 0;
  private audioFrames = 0;
  private queuedAudioBytes = 0;
  private pendingAudioWrites = 0;
  private turnsCompleted = 0;
  private terminal: SttTerminal | undefined;
  private providerFinished = false;
  private closeStreamState: 'not_sent' | 'send_pending' | 'sent' =
    'not_sent';
  private normalCloseWhileSendPending = false;
  private resolveClosed!: (terminal: SttTerminal) => void;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: Error) => void;
  private readonly connectedPromise: Promise<void>;
  private connectTimer: NodeJS.Timeout | undefined;
  private finishTimer: NodeJS.Timeout | undefined;
  private eventChain: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();
  private nextWriteSequence = 0;
  private writeGapSequence: number | undefined;
  private writeRecoverySequence: number | undefined;
  private pendingTurnEvents = 0;
  private readonly deliveryController = new AbortController();
  private deliveryCompromised = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly sessionOptions: SttSessionOptions,
    private readonly format: SttAudioFormat,
    private readonly providerOptions: ResolvedDeepgramOptions
  ) {
    this.stream = sessionOptions.stream;
    this.startedAtMs = providerOptions.now();
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    this.closed = new Promise<SttTerminal>((resolve) => {
      this.resolveClosed = resolve;
    });

    this.socket.on('message', this.handleMessage);
    this.socket.on('error', this.handleSocketError);
    this.socket.on('close', this.handleSocketClose);
    this.socket.on('unexpected-response', this.handleUnexpectedResponse);
    this.sessionOptions.signal.addEventListener('abort', this.handleAbort, {
      once: true,
    });

    this.connectTimer = setTimeout(() => {
      this.fail(
        new SttProviderError(
          'connection_timeout',
          'Deepgram connection timed out',
          true
        )
      );
    }, this.providerOptions.connectTimeoutMs);
  }

  get state(): SttSessionState {
    return this._state;
  }

  waitUntilConnected(): Promise<void> {
    return this.connectedPromise;
  }

  async writeAudio(audio: Buffer): Promise<void> {
    this.assertOpen('write audio');
    if (!Buffer.isBuffer(audio)) {
      throw new SttProviderError(
        'protocol_error',
        'STT audio must be a Buffer',
        false
      );
    }
    if (audio.length === 0) return;

    if (
      this.audioBytes +
        this.queuedAudioBytes +
        audio.length >
      this.providerOptions.maxAudioBytes
    ) {
      const error = new SttProviderError(
        'audio_limit_exceeded',
        'Deepgram stream exceeded the configured audio byte limit',
        false
      );
      this.fail(error);
      throw error;
    }
    const existingGap = this.writeGapSequence;
    const isGapRecovery = existingGap !== undefined;
    const writeSequence = isGapRecovery
      ? existingGap
      : this.nextWriteSequence++;
    if (
      isGapRecovery &&
      this.writeRecoverySequence !== undefined
    ) {
      throw new SttProviderError(
        'backpressure',
        'Deepgram audio queue is waiting for the rejected chunk retry',
        true
      );
    }
    if (
      this.pendingAudioWrites >=
      this.providerOptions.maxPendingAudioWrites
    ) {
      if (!isGapRecovery) this.recordWriteGap(writeSequence);
      throw new SttProviderError(
        'backpressure',
        'Deepgram audio write queue is full',
        true
      );
    }
    if (isGapRecovery) this.writeRecoverySequence = writeSequence;

    this.queuedAudioBytes += audio.length;
    this.pendingAudioWrites++;
    let copy: Buffer;
    try {
      copy = Buffer.from(audio);
    } catch (error) {
      this.queuedAudioBytes -= audio.length;
      this.pendingAudioWrites--;
      if (!isGapRecovery) this.recordWriteGap(writeSequence);
      if (this.writeRecoverySequence === writeSequence) {
        this.writeRecoverySequence = undefined;
      }
      throw error;
    }
    const queuedOperation = this.writeChain.then(async () => {
      this.queuedAudioBytes -= copy.length;
      if (isTerminalState(this._state)) {
        throw new SttProviderError(
          'invalid_state',
          `Cannot write audio while STT stream is ${this._state}`,
          false
        );
      }
      if (
        this.writeGapSequence !== undefined &&
        writeSequence > this.writeGapSequence
      ) {
        throw new SttProviderError(
          'backpressure',
          'Deepgram audio queue rejected data after an earlier ordering gap',
          true
        );
      }
      try {
        await this.writeAudioNow(copy);
        if (
          isGapRecovery &&
          this.writeGapSequence === writeSequence
        ) {
          this.writeGapSequence = undefined;
        }
      } catch (error) {
        if (
          error instanceof SttProviderError &&
          error.code === 'backpressure' &&
          !this.terminal
        ) {
          this.recordWriteGap(writeSequence);
        }
        throw error;
      }
    });
    const operation = queuedOperation.finally(() => {
      this.pendingAudioWrites--;
      if (this.writeRecoverySequence === writeSequence) {
        this.writeRecoverySequence = undefined;
      }
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  private async writeAudioNow(audio: Buffer): Promise<void> {
    if (this.audioBytes + audio.length > this.providerOptions.maxAudioBytes) {
      const error = new SttProviderError(
        'audio_limit_exceeded',
        'Deepgram stream exceeded the configured audio byte limit',
        false
      );
      this.fail(error);
      throw error;
    }

    const combinedBytes = this.pendingAudio.length + audio.length;
    const fullFrameBytes =
      Math.floor(combinedBytes / WIRE_FRAME_BYTES) * WIRE_FRAME_BYTES;
    if (
      fullFrameBytes > 0 &&
      this.socket.bufferedAmount + fullFrameBytes >
        this.providerOptions.maxSocketBufferedBytes
    ) {
      throw new SttProviderError(
        'backpressure',
        'Deepgram WebSocket send buffer is full',
        true
      );
    }

    this.pendingAudio =
      this.pendingAudio.length === 0
        ? audio
        : Buffer.concat([this.pendingAudio, audio]);
    this.audioBytes += audio.length;

    const completeAudio = this.pendingAudio;
    let offset = 0;
    while (completeAudio.length - offset >= WIRE_FRAME_BYTES) {
      if (this.terminal) {
        throw new SttProviderError(
          'invalid_state',
          `Cannot write audio while STT stream is ${this._state}`,
          false
        );
      }
      const frame = Buffer.from(
        completeAudio.subarray(offset, offset + WIRE_FRAME_BYTES)
      );
      await this.sendBinary(frame);
      if (this.terminal) {
        throw new SttProviderError(
          'invalid_state',
          `Cannot write audio while STT stream is ${this._state}`,
          false
        );
      }
      this.audioFrames++;
      offset += WIRE_FRAME_BYTES;
    }
    this.pendingAudio = Buffer.from(completeAudio.subarray(offset));
  }

  async finish(): Promise<SttTerminal> {
    if (this.terminal) return this.terminal;
    if (this._state === 'finishing') return this.closed;
    this.assertOpen('finish');

    this._state = 'finishing';
    this.finishTimer = setTimeout(() => {
      this.fail(
        new SttProviderError(
          'finish_timeout',
          'Deepgram did not close the stream in time',
          this.canRetryTransport()
        )
      );
    }, this.providerOptions.finishTimeoutMs);
    await Promise.race([
      this.writeChain,
      this.closed.then(() => undefined),
    ]);
    if (this.terminal) return this.terminal;
    if (this.writeGapSequence !== undefined) {
      this.fail(
        new SttProviderError(
          'backpressure',
          'Cannot finish Deepgram stream while an audio chunk awaits retry',
          false
        )
      );
      return this.closed;
    }
    try {
      if (this.pendingAudio.length > 0) {
        if (
          this.socket.bufferedAmount + this.pendingAudio.length >
          this.providerOptions.maxSocketBufferedBytes
        ) {
          this.fail(
            new SttProviderError(
              'backpressure',
              'Deepgram WebSocket send buffer is full',
              this.canRetryTransport()
            )
          );
          return this.closed;
        }
        const remainder = this.pendingAudio;
        this.pendingAudio = Buffer.alloc(0);
        await Promise.race([
          this.sendBinary(remainder),
          this.closed.then(() => undefined),
        ]);
        if (this.terminal) return this.terminal;
        this.audioFrames++;
      }
      this.closeStreamState = 'send_pending';
      await Promise.race([
        this.sendText(JSON.stringify({ type: 'CloseStream' })),
        this.closed.then(() => undefined),
      ]);
      if (this.terminal) return this.terminal;
      this.closeStreamState = 'sent';
      if (this.normalCloseWhileSendPending) {
        this.complete();
      }
    } catch {
      return this.closed;
    }

    return this.closed;
  }

  private readonly handleMessage = (
    raw: RawData,
    isBinary: boolean
  ): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    if (isBinary) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'Deepgram returned an unexpected binary frame',
          false
        )
      );
      return;
    }

    let event: DeepgramServerEvent | undefined;
    try {
      event = parseServerEvent(raw);
    } catch {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'Deepgram returned an invalid JSON message',
          false
        )
      );
      return;
    }
    if (!event) return;

    if (event.sequenceId <= this.lastServerSequence) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'Deepgram server sequence did not increase',
          false
        )
      );
      return;
    }
    this.lastServerSequence = event.sequenceId;

    if (event.type === 'Connected') {
      this.handleConnected(event);
      return;
    }
    if (event.type === 'Error') {
      this.fail(
        new SttProviderError(
          'provider_error',
          providerErrorMessage(event.code),
          isRetryableProviderCode(event.code) &&
            this.canRetryTransport()
        )
      );
      return;
    }
    if (this._state === 'opening' || this.requestId === undefined) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'Deepgram sent transcript data before Connected',
          false
        )
      );
      return;
    }

    const turn = normalizeTurn(event);
    if (turn.kind === 'end_of_turn') this.turnsCompleted++;
    this.emit({
      ...this.eventBase(),
      type: 'turn',
      turn,
    });
  };

  private handleConnected(event: DeepgramConnected): void {
    if (this._state !== 'opening' || this.requestId !== undefined) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'Deepgram sent duplicate Connected messages',
          false
        )
      );
      return;
    }

    this.clearTimer('connect');
    this.requestId = event.requestId;
    this.connectedAtMs = this.providerOptions.now();
    this._state = 'open';
    this.resolveConnected();
    this.emit({
      ...this.eventBase(),
      type: 'session_started',
      requestId: event.requestId,
      connectMs: this.connectedAtMs - this.startedAtMs,
      format: this.format,
    });
  }

  private readonly handleSocketError = (): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    this.fail(
      new SttProviderError(
        'socket_error',
        'Deepgram WebSocket error',
        this.canRetryTransport()
      )
    );
  };

  private readonly handleSocketClose = (code: number): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    if (this._state === 'finishing' && (code === 1000 || code === 1005)) {
      if (this.closeStreamState === 'sent') {
        this.complete();
        return;
      }
      if (this.closeStreamState === 'send_pending') {
        this.normalCloseWhileSendPending = true;
        return;
      }
    }
    this.fail(
      new SttProviderError(
        'unexpected_close',
        `Deepgram WebSocket closed before completion (code ${code})`,
        this.canRetryTransport()
      )
    );
  };

  private readonly handleUnexpectedResponse = (
    _request: ClientRequest,
    response: IncomingMessage
  ): void => {
    if (isTerminalState(this._state)) return;
    const status = response.statusCode ?? 0;
    const configurationFailure =
      status === 400 ||
      status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 404 ||
      status === 422;
    const retryable =
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      (status >= 500 && status <= 599);
    this.fail(
      new SttProviderError(
        configurationFailure ? 'configuration' : 'socket_error',
        `Deepgram WebSocket handshake failed (status ${status || 'unknown'})`,
        retryable
      )
    );
  };

  private readonly handleAbort = (): void => {
    if (this.terminal) return;
    const reason = abortReason(this.sessionOptions.signal);
    const wasOpening = this._state === 'opening';
    this._state = 'cancelled';
    this.pendingAudio = Buffer.alloc(0);
    this.deliveryController.abort(reason);
    const terminal: SttTerminal = Object.freeze({
      status: 'cancelled',
      reason,
      audioBytes: this.audioBytes,
      audioFrames: this.audioFrames,
      turnsCompleted: this.turnsCompleted,
      totalMs: this.elapsedMs(),
    });
    this.commitTerminal(terminal);
    if (wasOpening) {
      this.rejectConnected(
        new SttProviderError(
          'invalid_state',
          'STT stream was cancelled before opening',
          false
        )
      );
    }
    this.terminateSocket();
  };

  private assertOpen(operation: string): void {
    if (this._state !== 'open') {
      throw new SttProviderError(
        'invalid_state',
        `Cannot ${operation} while STT stream is ${this._state}`,
        false
      );
    }
  }

  private sendBinary(data: Buffer): Promise<void> {
    return this.sendSocketFrame(
      data,
      { binary: true },
      'Unable to send audio to Deepgram'
    );
  }

  private sendText(data: string): Promise<void> {
    return this.sendSocketFrame(
      data,
      undefined,
      'Unable to send control data to Deepgram'
    );
  }

  private sendSocketFrame(
    data: Buffer | string,
    options: { binary: boolean } | undefined,
    failureMessage: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const error = new SttProviderError(
        'socket_error',
        failureMessage,
        this.canRetryTransport()
      );
      let settled = false;
      const failSend = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.fail(error);
        reject(error);
      };
      const timer = setTimeout(
        failSend,
        this.providerOptions.sendTimeoutMs
      );
      if (this.socket.readyState !== WebSocket.OPEN) {
        failSend();
        return;
      }

      const onSent = (sendError?: Error): void => {
        if (sendError) {
          failSend();
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      try {
        if (options) this.socket.send(data, options, onSent);
        else this.socket.send(data, onSent);
      } catch {
        failSend();
      }
    });
  }

  private complete(): void {
    if (this.terminal || this.providerFinished) return;
    this.providerFinished = true;
    this.clearTimer('finish');
    const pendingDelivery = this.eventChain;
    void pendingDelivery.then(() => {
      if (this.terminal) return;
      this._state = 'completed';
      this.commitTerminal(
        Object.freeze({
          status: 'completed',
          audioBytes: this.audioBytes,
          audioFrames: this.audioFrames,
          turnsCompleted: this.turnsCompleted,
          totalMs: this.elapsedMs(),
        })
      );
    });
  }

  private fail(error: SttProviderError): void {
    if (this.terminal) return;
    const wasOpening = this._state === 'opening';
    this._state = 'failed';
    this.pendingAudio = Buffer.alloc(0);
    this.deliveryController.abort(error.code);
    const terminal: SttTerminal = Object.freeze({
      status: 'failed',
      error,
      audioStarted: this.audioBytes > 0,
      audioBytes: this.audioBytes,
      audioFrames: this.audioFrames,
      turnsCompleted: this.turnsCompleted,
      totalMs: this.elapsedMs(),
    });
    this.commitTerminal(terminal, error);
    if (wasOpening) this.rejectConnected(error);
    this.terminateSocket();
  }

  private commitTerminal(
    terminal: SttTerminal,
    error?: SttProviderError
  ): void {
    if (this.terminal) return;
    this.terminal = terminal;
    this.clearTimer('connect');
    this.clearTimer('finish');
    this.sessionOptions.signal.removeEventListener('abort', this.handleAbort);
    if (error) {
      this.emit({
        ...this.eventBase(),
        type: 'error',
        error,
      });
    }
    const terminalDelivery = this.emit({
      ...this.eventBase(),
      type: 'terminal',
      terminal,
    });
    void terminalDelivery.finally(() => {
      this.resolveClosed(terminal);
    });
  }

  private eventBase() {
    return {
      transcriptionId: this.transcriptionId,
      attemptId: this.attemptId,
      provider: this.provider,
      stream: this.stream,
      timestampMs: this.providerOptions.now(),
      signal: this.deliveryController.signal,
    } as const;
  }

  private emit(event: SttSessionEvent): Promise<void> {
    if (
      event.type === 'turn' &&
      this.pendingTurnEvents >=
        this.providerOptions.maxPendingTurnEvents
    ) {
      this.deliveryCompromised = true;
      this.deliveryController.abort('event-queue-overflow');
      this.fail(
        new SttProviderError(
          'backpressure',
          'STT event delivery queue is full',
          false
        )
      );
      return this.eventChain;
    }
    if (event.type === 'turn') this.pendingTurnEvents++;

    this.eventChain = this.eventChain
      .then(async () => {
        if (
          event.type === 'turn' &&
          (this.deliveryCompromised ||
            this._state === 'cancelled' ||
            this._state === 'failed')
        ) {
          return;
        }
        await this.deliverEvent(event);
      })
      .finally(() => {
        if (event.type === 'turn') this.pendingTurnEvents--;
      });
    return this.eventChain;
  }

  private deliverEvent(event: SttSessionEvent): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const deliveryFailed = (error: unknown, reason: string): void => {
        this.reportEventHandlerError(error, event);
        if (event.type === 'terminal' || event.type === 'error') return;
        this.deliveryCompromised = true;
        this.deliveryController.abort(reason);
        this.fail(
          new SttProviderError(
            'backpressure',
            'STT event delivery failed',
            false
          )
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        deliveryFailed(
          new Error('STT event handler timed out'),
          'event-handler-timeout'
        );
        finish();
      }, this.providerOptions.eventHandlerTimeoutMs);

      try {
        void Promise.resolve(this.sessionOptions.onEvent(event))
          .catch((error) => {
            if (!settled) deliveryFailed(error, 'event-handler-error');
          })
          .finally(finish);
      } catch (error) {
        deliveryFailed(error, 'event-handler-error');
        finish();
      }
    });
  }

  private reportEventHandlerError(
    error: unknown,
    event: SttSessionEvent
  ): void {
    try {
      this.providerOptions.onEventHandlerError(error, {
        provider: 'deepgram-flux',
        eventType: event.type,
        transcriptionId: this.transcriptionId,
        attemptId: this.attemptId,
      });
    } catch {
      // Observability must not destabilize the transcription state machine.
    }
  }

  private elapsedMs(): number {
    return this.providerOptions.now() - this.startedAtMs;
  }

  private canRetryTransport(): boolean {
    // Reconnecting after audio was accepted could emit duplicate transcript
    // events unless the caller owns an explicit replay/idempotency strategy.
    return this.audioBytes === 0;
  }

  private recordWriteGap(sequence: number): void {
    if (
      this.writeGapSequence === undefined ||
      sequence < this.writeGapSequence
    ) {
      this.writeGapSequence = sequence;
    }
  }

  private terminateSocket(): void {
    try {
      if (this.socket.readyState !== WebSocket.CLOSED) {
        this.socket.terminate();
      }
    } catch {
      // The terminal state has already been committed.
    }
  }

  private clearTimer(timer: 'connect' | 'finish'): void {
    const handle = timer === 'connect' ? this.connectTimer : this.finishTimer;
    if (handle) clearTimeout(handle);
    if (timer === 'connect') this.connectTimer = undefined;
    else this.finishTimer = undefined;
  }
}

function resolveOptions(
  options: DeepgramFluxSttProviderOptions
): ResolvedDeepgramConfiguration {
  if (!options.apiKey?.trim()) {
    throw new SttProviderError(
      'configuration',
      'Deepgram API key is required',
      false
    );
  }

  const url = validateEndpoint(
    options.url ?? DEFAULT_URL,
    options.allowCustomEndpoint ?? false
  );
  const model = options.model ?? DEFAULT_MODEL;
  if (model !== 'flux-general-multi') {
    throw new SttProviderError(
      'configuration',
      'Deepgram Flux multilingual model is required',
      false
    );
  }

  const languageHints = normalizeLanguageHints(
    options.languageHints ?? ['ru']
  );
  const eotThreshold = finiteRange(
    options.eotThreshold,
    0.7,
    0.5,
    0.9,
    'eotThreshold'
  );
  const eagerEotThreshold =
    options.eagerEotThreshold === undefined
      ? undefined
      : finiteRange(
          options.eagerEotThreshold,
          options.eagerEotThreshold,
          0.3,
          0.9,
          'eagerEotThreshold'
        );
  if (
    eagerEotThreshold !== undefined &&
    eagerEotThreshold > eotThreshold
  ) {
    throw new SttProviderError(
      'configuration',
      'eagerEotThreshold cannot exceed eotThreshold',
      false
    );
  }
  const eotTimeoutMs = integerRange(
    options.eotTimeoutMs,
    1800,
    500,
    10_000,
    'eotTimeoutMs'
  );
  const connectTimeoutMs = positiveInteger(
    options.connectTimeoutMs,
    5_000,
    'connectTimeoutMs'
  );
  const finishTimeoutMs = positiveInteger(
    options.finishTimeoutMs,
    5_000,
    'finishTimeoutMs'
  );
  const sendTimeoutMs = positiveInteger(
    options.sendTimeoutMs,
    2_000,
    'sendTimeoutMs'
  );
  const eventHandlerTimeoutMs = positiveInteger(
    options.eventHandlerTimeoutMs,
    2_000,
    'eventHandlerTimeoutMs'
  );
  const maxSocketBufferedBytes = positiveInteger(
    options.maxSocketBufferedBytes,
    256 * 1024,
    'maxSocketBufferedBytes'
  );
  if (maxSocketBufferedBytes < WIRE_FRAME_BYTES) {
    throw new SttProviderError(
      'configuration',
      `maxSocketBufferedBytes must be at least ${WIRE_FRAME_BYTES}`,
      false
    );
  }
  const maxAudioDurationMs = positiveInteger(
    options.maxAudioDurationMs,
    2 * 60 * 60 * 1_000,
    'maxAudioDurationMs'
  );
  const maxIncomingFrameBytes = positiveInteger(
    options.maxIncomingFrameBytes,
    256 * 1024,
    'maxIncomingFrameBytes'
  );
  const maxPendingAudioWrites = positiveInteger(
    options.maxPendingAudioWrites,
    64,
    'maxPendingAudioWrites'
  );
  const maxPendingTurnEvents = positiveInteger(
    options.maxPendingTurnEvents,
    16,
    'maxPendingTurnEvents'
  );

  return Object.freeze({
    apiKey: options.apiKey.trim(),
    options: Object.freeze({
      url,
      model,
      languageHints,
      eotThreshold,
      ...(eagerEotThreshold === undefined ? {} : { eagerEotThreshold }),
      eotTimeoutMs,
      connectTimeoutMs,
      finishTimeoutMs,
      sendTimeoutMs,
      eventHandlerTimeoutMs,
      maxSocketBufferedBytes,
      maxAudioBytes: Math.ceil((maxAudioDurationMs * 8000) / 1000),
      maxIncomingFrameBytes,
      maxPendingAudioWrites,
      maxPendingTurnEvents,
      webSocketFactory:
        options.webSocketFactory ??
        ((
          socketUrl: string,
          socketOptions: WebSocketClientOptions
        ) => new WebSocket(socketUrl, socketOptions)),
      now: options.now ?? Date.now,
      onEventHandlerError:
        options.onEventHandlerError ?? (() => undefined),
    }),
  });
}

function validateEndpoint(value: string, allowCustomEndpoint: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SttProviderError(
      'configuration',
      'Deepgram WebSocket endpoint is invalid',
      false
    );
  }

  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new SttProviderError(
      'configuration',
      'Deepgram WebSocket endpoint must use authenticated WSS transport',
      false
    );
  }
  if (
    !allowCustomEndpoint &&
    (url.hostname !== 'api.deepgram.com' ||
      url.pathname !== '/v2/listen' ||
      url.port !== '')
  ) {
    throw new SttProviderError(
      'configuration',
      'Custom Deepgram WebSocket endpoints require explicit opt-in',
      false
    );
  }
  return url.toString();
}

function buildConnectionUrl(options: ResolvedDeepgramOptions): string {
  const url = new URL(options.url);
  url.searchParams.set('model', options.model);
  url.searchParams.set('encoding', 'mulaw');
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.delete('language_hint');
  for (const hint of options.languageHints) {
    url.searchParams.append('language_hint', hint);
  }
  url.searchParams.set('eot_threshold', String(options.eotThreshold));
  url.searchParams.set('eot_timeout_ms', String(options.eotTimeoutMs));
  if (options.eagerEotThreshold === undefined) {
    url.searchParams.delete('eager_eot_threshold');
  } else {
    url.searchParams.set(
      'eager_eot_threshold',
      String(options.eagerEotThreshold)
    );
  }
  return url.toString();
}

function parseServerEvent(raw: RawData): DeepgramServerEvent | undefined {
  const value: unknown = JSON.parse(rawDataToUtf8(raw));
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new Error('invalid Deepgram message');
  }

  if (value['type'] === 'Connected') {
    return {
      type: 'Connected',
      requestId: nonEmptyString(value['request_id']),
      sequenceId: nonNegativeInteger(value['sequence_id']),
    };
  }
  if (value['type'] === 'Error') {
    return {
      type: 'Error',
      sequenceId: nonNegativeInteger(value['sequence_id']),
      code: nonEmptyString(value['code']),
    };
  }
  if (value['type'] !== 'TurnInfo') return undefined;

  const event = value['event'];
  if (
    event !== 'Update' &&
    event !== 'StartOfTurn' &&
    event !== 'EndOfTurn' &&
    event !== 'EagerEndOfTurn' &&
    event !== 'TurnResumed'
  ) {
    throw new Error('invalid Deepgram turn event');
  }

  const audioWindowStart = nonNegativeFinite(value['audio_window_start']);
  const audioWindowEnd = nonNegativeFinite(value['audio_window_end']);
  if (audioWindowEnd < audioWindowStart) {
    throw new Error('invalid Deepgram audio window');
  }
  const transcript = stringValue(value['transcript']);
  if (
    (event === 'StartOfTurn' || event === 'EagerEndOfTurn') &&
    !transcript.trim()
  ) {
    throw new Error('invalid empty Deepgram turn transcript');
  }

  return {
    type: 'TurnInfo',
    requestId: nonEmptyString(value['request_id']),
    sequenceId: nonNegativeInteger(value['sequence_id']),
    event,
    turnIndex: nonNegativeInteger(value['turn_index']),
    audioWindowStart,
    audioWindowEnd,
    transcript,
    words: parseWords(value['words']),
    endOfTurnConfidence: probability(value['end_of_turn_confidence']),
    languages: optionalStringArray(value['languages']),
    languagesHinted: optionalStringArray(value['languages_hinted']),
  };
}

function normalizeTurn(event: DeepgramTurnInfo): SttTurnSnapshot {
  const kind = normalizeTurnKind(event.event);
  return Object.freeze({
    kind,
    turnIndex: event.turnIndex,
    transcript: event.transcript,
    words: event.words,
    audioWindowStartMs: Math.round(event.audioWindowStart * 1000),
    audioWindowEndMs: Math.round(event.audioWindowEnd * 1000),
    endOfTurnConfidence: event.endOfTurnConfidence,
    isFinal: kind === 'end_of_turn',
    isSpeculative: kind === 'eager_end_of_turn',
    requestId: event.requestId,
    serverSequence: event.sequenceId,
    languages: event.languages,
    languagesHinted: event.languagesHinted,
  });
}

function normalizeTurnKind(
  event: DeepgramTurnInfo['event']
): SttTurnEventKind {
  switch (event) {
    case 'Update':
      return 'update';
    case 'StartOfTurn':
      return 'start_of_turn';
    case 'EagerEndOfTurn':
      return 'eager_end_of_turn';
    case 'TurnResumed':
      return 'turn_resumed';
    case 'EndOfTurn':
      return 'end_of_turn';
  }
}

function parseWords(value: unknown): readonly SttWord[] {
  if (!Array.isArray(value)) throw new Error('invalid Deepgram words');
  return Object.freeze(
    value.map((item) => {
      if (!isRecord(item)) throw new Error('invalid Deepgram word');
      const start = optionalNonNegativeFinite(item['start']);
      const end = optionalNonNegativeFinite(item['end']);
      if (start !== undefined && end !== undefined && end < start) {
        throw new Error('invalid Deepgram word window');
      }
      return Object.freeze({
        text: nonEmptyString(item['word']),
        confidence: probability(item['confidence']),
        ...(start === undefined
          ? {}
          : { startMs: Math.round(start * 1000) }),
        ...(end === undefined
          ? {}
          : { endMs: Math.round(end * 1000) }),
      });
    })
  );
}

function rawDataToUtf8(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function providerErrorMessage(code: string): string {
  // Provider-controlled fields are intentionally excluded: a malformed error
  // frame must not be able to reflect credentials or customer audio metadata.
  void code;
  return 'Deepgram reported a provider error';
}

function isRetryableProviderCode(code: string): boolean {
  return new Set([
    'INTERNAL_SERVER_ERROR',
    'SERVICE_UNAVAILABLE',
    'TOO_MANY_REQUESTS',
    'RATE_LIMITED',
    'REQUEST_TIMEOUT',
    'TIMEOUT',
  ]).has(code.toUpperCase());
}

function normalizeLanguageHints(hints: readonly string[]): readonly string[] {
  if (hints.length === 0) return Object.freeze([]);
  const normalized = hints.map((hint) => hint.trim().toLowerCase());
  if (
    normalized.some(
      (hint) =>
        !/^[a-z]{2}(?:-[a-z]{2})?$/.test(hint) ||
        !SUPPORTED_FLUX_LANGUAGE_BASES.has(hint.split('-')[0]!)
    )
  ) {
    throw new SttProviderError(
      'configuration',
      'Deepgram language hints must be supported by Flux multilingual',
      false
    );
  }
  return Object.freeze([...new Set(normalized)]);
}

function finiteRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new SttProviderError(
      'configuration',
      `${label} must be between ${minimum} and ${maximum}`,
      false
    );
  }
  return resolved;
}

function integerRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new SttProviderError(
      'configuration',
      `${label} must be an integer between ${minimum} and ${maximum}`,
      false
    );
  }
  return resolved;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new SttProviderError(
      'configuration',
      `${label} must be a positive integer`,
      false
    );
  }
  return resolved;
}

function validateStream(stream: SttSessionOptions['stream']): void {
  if (!stream.callId?.trim() || !stream.conversationId?.trim()) {
    throw new SttProviderError(
      'configuration',
      'STT callId and conversationId are required',
      false
    );
  }
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('expected non-empty string');
  }
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected string');
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error('expected non-negative integer');
  }
  return value as number;
}

function nonNegativeFinite(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error('expected non-negative finite number');
  }
  return value;
}

function optionalNonNegativeFinite(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeFinite(value);
}

function probability(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error('expected probability');
  }
  return value;
}

function optionalStringArray(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item)
  ) {
    throw new Error('expected string array');
  }
  return Object.freeze([...value]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return 'cancelled';
}

function isTerminalState(state: SttSessionState): boolean {
  return (
    state === 'completed' ||
    state === 'cancelled' ||
    state === 'failed'
  );
}
