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

const DEFAULT_URL = 'wss://streaming.assemblyai.com/v3/ws';
const DEFAULT_MODEL = 'whisper-rt';
const WIRE_FRAME_BYTES = 400;
const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_WORDS_PER_TURN = 10_000;

export type AssemblyAiWebSocketFactory = (
  url: string,
  options: WebSocketClientOptions
) => WebSocket;

export type AssemblyAiSttEventHandlerErrorContext = Readonly<{
  provider: 'assemblyai-streaming-v3';
  eventType: SttSessionEvent['type'];
  transcriptionId: string;
  attemptId: string;
}>;

export type AssemblyAiStreamingSttProviderOptions = Readonly<{
  apiKey: string;
  url?: string;
  allowCustomEndpoint?: boolean;
  speechModel?: 'whisper-rt';
  minTurnSilenceMs?: number;
  maxTurnSilenceMs?: number;
  connectTimeoutMs?: number;
  finishTimeoutMs?: number;
  forceEndpointTimeoutMs?: number;
  sendTimeoutMs?: number;
  eventHandlerTimeoutMs?: number;
  maxSocketBufferedBytes?: number;
  maxAudioDurationMs?: number;
  maxIncomingFrameBytes?: number;
  maxPendingAudioWrites?: number;
  maxPendingTurnEvents?: number;
  webSocketFactory?: AssemblyAiWebSocketFactory;
  now?: () => number;
  onEventHandlerError?: (
    error: unknown,
    context: AssemblyAiSttEventHandlerErrorContext
  ) => void;
}>;

type ResolvedAssemblyAiOptions = Readonly<{
  url: string;
  speechModel: 'whisper-rt';
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  connectTimeoutMs: number;
  finishTimeoutMs: number;
  forceEndpointTimeoutMs: number;
  sendTimeoutMs: number;
  eventHandlerTimeoutMs: number;
  maxSocketBufferedBytes: number;
  maxAudioBytes: number;
  maxIncomingFrameBytes: number;
  maxPendingAudioWrites: number;
  maxPendingTurnEvents: number;
  webSocketFactory: AssemblyAiWebSocketFactory;
  now: () => number;
  onEventHandlerError: (
    error: unknown,
    context: AssemblyAiSttEventHandlerErrorContext
  ) => void;
}>;

type ResolvedAssemblyAiConfiguration = Readonly<{
  apiKey: string;
  options: ResolvedAssemblyAiOptions;
}>;

type AssemblyAiBegin = Readonly<{
  type: 'Begin';
  id: string;
  expiresAt: number;
}>;

type AssemblyAiTurn = Readonly<{
  type: 'Turn';
  turnOrder: number;
  turnIsFormatted: boolean;
  endOfTurn: boolean;
  transcript: string;
  utterance: string;
  endOfTurnConfidence: number;
  words: readonly SttWord[];
  languageCode?: string;
}>;

type AssemblyAiTermination = Readonly<{
  type: 'Termination';
  audioDurationSeconds: number;
  sessionDurationSeconds: number;
}>;

type AssemblyAiProviderFailure = Readonly<{
  type: 'Error';
  code?: string;
}>;

type AssemblyAiServerEvent =
  | AssemblyAiBegin
  | AssemblyAiTurn
  | AssemblyAiTermination
  | AssemblyAiProviderFailure;

export class AssemblyAiStreamingSttProvider
  implements StreamingSttProvider
{
  readonly name = 'assemblyai-streaming-v3';
  readonly inputFormat: SttAudioFormat = Object.freeze({
    encoding: 'mulaw',
    sampleRateHz: 8000,
    channels: 1,
  });

  readonly #apiKey: string;
  private readonly options: ResolvedAssemblyAiOptions;

  constructor(options: AssemblyAiStreamingSttProviderOptions) {
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
            Authorization: this.#apiKey,
          },
          maxPayload: this.options.maxIncomingFrameBytes,
          perMessageDeflate: false,
        }
      );
    } catch {
      throw new SttProviderError(
        'socket_error',
        'Unable to create AssemblyAI WebSocket',
        true
      );
    }

    const session = new AssemblyAiStreamingSttSession(
      socket,
      options,
      this.inputFormat,
      this.options
    );
    await session.waitUntilConnected();
    return session;
  }
}

class AssemblyAiStreamingSttSession implements StreamingSttSession {
  readonly provider = 'assemblyai-streaming-v3';
  readonly transcriptionId = randomUUID();
  readonly attemptId = randomUUID();
  readonly stream: SttSessionOptions['stream'];
  readonly closed: Promise<SttTerminal>;

  private _state: SttSessionState = 'opening';
  private readonly startedAtMs: number;
  private connectedAtMs: number | undefined;
  private requestId: string | undefined;
  private lastTurnOrder = -1;
  private serverSequence = 0;
  private pendingAudio: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private audioBytes = 0;
  private audioFrames = 0;
  private queuedAudioBytes = 0;
  private pendingAudioWrites = 0;
  private turnsCompleted = 0;
  private terminal: SttTerminal | undefined;
  private providerFinished = false;
  private terminationState: 'not_sent' | 'send_pending' | 'sent' =
    'not_sent';
  private terminationReceived = false;
  private activeTurnOrder: number | undefined;
  private endpointTurnOrder: number | undefined;
  private startedTurnOrder: number | undefined;
  private finalizedThroughTurnOrder = -1;
  private lastFingerprintTurnOrder: number | undefined;
  private lastTurnFingerprint: string | undefined;
  private resolveClosed!: (terminal: SttTerminal) => void;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: Error) => void;
  private readonly connectedPromise: Promise<void>;
  private connectTimer: NodeJS.Timeout | undefined;
  private finishTimer: NodeJS.Timeout | undefined;
  private endpointTimer: NodeJS.Timeout | undefined;
  private eventChain: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();
  private pendingTurnEvents = 0;
  private readonly deliveryController = new AbortController();
  private deliveryCompromised = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly sessionOptions: SttSessionOptions,
    private readonly format: SttAudioFormat,
    private readonly providerOptions: ResolvedAssemblyAiOptions
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
          'AssemblyAI connection timed out',
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
      this.audioBytes + this.queuedAudioBytes + audio.length >
      this.providerOptions.maxAudioBytes
    ) {
      const error = new SttProviderError(
        'audio_limit_exceeded',
        'AssemblyAI stream exceeded the configured audio byte limit',
        false
      );
      this.fail(error);
      throw error;
    }
    if (
      this.pendingAudioWrites >=
      this.providerOptions.maxPendingAudioWrites
    ) {
      const error = new SttProviderError(
        'backpressure',
        'AssemblyAI audio write queue is full',
        false
      );
      this.fail(error);
      throw error;
    }

    let copy: Buffer;
    try {
      copy = Buffer.from(audio);
    } catch (error) {
      throw error;
    }
    this.queuedAudioBytes += copy.length;
    this.pendingAudioWrites++;

    const operation = this.writeChain
      .then(async () => {
        this.queuedAudioBytes -= copy.length;
        if (this._state !== 'open') {
          throw new SttProviderError(
            'invalid_state',
            `Cannot write audio while STT stream is ${this._state}`,
            false
          );
        }
        await this.writeAudioNow(copy);
      })
      .catch((error: unknown) => {
        if (
          error instanceof SttProviderError &&
          !this.terminal &&
          error.code !== 'invalid_state'
        ) {
          this.fail(error);
        }
        throw error;
      })
      .finally(() => {
        this.pendingAudioWrites--;
      });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  private async writeAudioNow(audio: Buffer): Promise<void> {
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
        'AssemblyAI WebSocket send buffer is full',
        false
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
          'AssemblyAI did not terminate the stream in time',
          false
        )
      );
    }, this.providerOptions.finishTimeoutMs);

    await Promise.race([
      this.writeChain,
      this.closed.then(() => undefined),
    ]);
    if (this.terminal) return this.terminal;

    try {
      if (this.pendingAudio.length > 0) {
        if (
          this.socket.bufferedAmount + this.pendingAudio.length >
          this.providerOptions.maxSocketBufferedBytes
        ) {
          this.fail(
            new SttProviderError(
              'backpressure',
              'AssemblyAI WebSocket send buffer is full',
              false
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

      if (
        this.activeTurnOrder !== undefined &&
        this.activeTurnOrder > this.finalizedThroughTurnOrder
      ) {
        this.endpointTurnOrder = this.activeTurnOrder;
        await Promise.race([
          this.sendText(JSON.stringify({ type: 'ForceEndpoint' })),
          this.closed.then(() => undefined),
        ]);
        if (this.terminal) return this.terminal;
        this.endpointTimer = setTimeout(() => {
          void this.requestTermination().catch(() => undefined);
        }, this.providerOptions.forceEndpointTimeoutMs);
      } else {
        await this.requestTermination();
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
          'AssemblyAI returned an unexpected binary frame',
          false
        )
      );
      return;
    }
    if (rawDataByteLength(raw) > this.providerOptions.maxIncomingFrameBytes) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'AssemblyAI response exceeded the configured frame limit',
          false
        )
      );
      return;
    }

    let event: AssemblyAiServerEvent | undefined;
    try {
      event = parseServerEvent(raw);
    } catch {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'AssemblyAI returned an invalid JSON message',
          false
        )
      );
      return;
    }
    if (!event) return;

    if (event.type === 'Begin') {
      this.handleBegin(event);
      return;
    }
    if (event.type === 'Error') {
      this.fail(
        new SttProviderError(
          'provider_error',
          'AssemblyAI reported a provider error',
          isRetryableProviderCode(event.code) &&
            this.audioBytes === 0
        )
      );
      return;
    }
    if (this._state === 'opening' || this.requestId === undefined) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'AssemblyAI sent stream data before Begin',
          false
        )
      );
      return;
    }
    if (event.type === 'Termination') {
      this.handleTermination();
      return;
    }

    this.handleTurn(event);
  };

  private handleBegin(event: AssemblyAiBegin): void {
    if (this._state !== 'opening' || this.requestId !== undefined) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'AssemblyAI sent duplicate Begin messages',
          false
        )
      );
      return;
    }
    void event.expiresAt;
    this.clearTimer('connect');
    this.requestId = event.id;
    this.connectedAtMs = this.providerOptions.now();
    this._state = 'open';
    this.resolveConnected();
    this.emit({
      ...this.eventBase(),
      type: 'session_started',
      requestId: event.id,
      connectMs: this.connectedAtMs - this.startedAtMs,
      format: this.format,
    });
  }

  private handleTurn(event: AssemblyAiTurn): void {
    if (event.turnOrder < this.lastTurnOrder) {
      if (event.turnOrder <= this.finalizedThroughTurnOrder) return;
      this.fail(
        new SttProviderError(
          'protocol_error',
          'AssemblyAI turn order regressed',
          false
        )
      );
      return;
    }
    if (event.turnOrder > this.lastTurnOrder) {
      this.lastFingerprintTurnOrder = undefined;
      this.lastTurnFingerprint = undefined;
    }
    this.lastTurnOrder = Math.max(this.lastTurnOrder, event.turnOrder);

    if (event.turnOrder <= this.finalizedThroughTurnOrder) return;
    const fingerprint = turnFingerprint(event);
    if (
      this.lastFingerprintTurnOrder === event.turnOrder &&
      this.lastTurnFingerprint === fingerprint
    ) {
      return;
    }
    this.lastFingerprintTurnOrder = event.turnOrder;
    this.lastTurnFingerprint = fingerprint;

    const transcript = event.transcript.trim();
    const isFinal = event.endOfTurn && event.turnIsFormatted;
    if (transcript) this.activeTurnOrder = event.turnOrder;

    if (isFinal) {
      this.finalizedThroughTurnOrder = Math.max(
        this.finalizedThroughTurnOrder,
        event.turnOrder
      );
      this.lastFingerprintTurnOrder = undefined;
      this.lastTurnFingerprint = undefined;
      if (this.activeTurnOrder === event.turnOrder) {
        this.activeTurnOrder = undefined;
      }
      if (transcript) {
        this.turnsCompleted++;
        this.startedTurnOrder = event.turnOrder;
        this.emitTurn(event, 'end_of_turn');
      }
      if (this.endpointTurnOrder === event.turnOrder) {
        this.endpointTurnOrder = undefined;
        this.clearTimer('endpoint');
        void this.requestTermination().catch(() => undefined);
      }
      return;
    }
    if (!transcript) return;

    let kind: SttTurnEventKind;
    if (event.utterance.trim()) {
      kind = 'eager_end_of_turn';
    } else if (this.startedTurnOrder !== event.turnOrder) {
      kind = 'start_of_turn';
    } else {
      kind = 'update';
    }
    this.startedTurnOrder = event.turnOrder;
    this.emitTurn(event, kind);
  }

  private emitTurn(
    event: AssemblyAiTurn,
    kind: SttTurnEventKind
  ): void {
    const turn: SttTurnSnapshot = Object.freeze({
      kind,
      turnIndex: event.turnOrder,
      transcript: event.transcript,
      words: event.words,
      audioWindowStartMs: event.words[0]?.startMs ?? 0,
      audioWindowEndMs:
        event.words[event.words.length - 1]?.endMs ?? 0,
      endOfTurnConfidence: event.endOfTurnConfidence,
      isFinal: kind === 'end_of_turn',
      isSpeculative: kind === 'eager_end_of_turn',
      requestId: this.requestId!,
      serverSequence: this.serverSequence++,
      languages: event.languageCode
        ? Object.freeze([event.languageCode])
        : Object.freeze([]),
      languagesHinted: Object.freeze([]),
    });
    this.emit({
      ...this.eventBase(),
      type: 'turn',
      turn,
    });
  }

  private handleTermination(): void {
    if (
      this._state !== 'finishing' ||
      this.terminationState === 'not_sent'
    ) {
      this.fail(
        new SttProviderError(
          'protocol_error',
          'AssemblyAI sent an unexpected Termination message',
          false
        )
      );
      return;
    }
    this.terminationReceived = true;
    this.complete();
  }

  private requestTermination(): Promise<void> {
    if (
      this.terminal ||
      this.terminationState !== 'not_sent'
    ) {
      return Promise.resolve();
    }
    this.clearTimer('endpoint');
    this.terminationState = 'send_pending';
    return this.sendText(JSON.stringify({ type: 'Terminate' })).then(() => {
      if (this.terminal) return;
      this.terminationState = 'sent';
      if (this.terminationReceived) this.complete();
    });
  }

  private readonly handleSocketError = (): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    this.fail(
      new SttProviderError(
        'socket_error',
        'AssemblyAI WebSocket error',
        this.audioBytes === 0
      )
    );
  };

  private readonly handleSocketClose = (code: number): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    this.fail(
      new SttProviderError(
        'unexpected_close',
        `AssemblyAI WebSocket closed before Termination (code ${code})`,
        this.audioBytes === 0
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
        `AssemblyAI WebSocket handshake failed (status ${status || 'unknown'})`,
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
      'Unable to send audio to AssemblyAI'
    );
  }

  private sendText(data: string): Promise<void> {
    return this.sendSocketFrame(
      data,
      undefined,
      'Unable to send control data to AssemblyAI'
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
        this.audioBytes === 0
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
    this.clearTimer('endpoint');
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
      this.closeSocket();
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
    this.clearTimer('endpoint');
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
        provider: 'assemblyai-streaming-v3',
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

  private clearTimer(timer: 'connect' | 'finish' | 'endpoint'): void {
    const handle =
      timer === 'connect'
        ? this.connectTimer
        : timer === 'finish'
          ? this.finishTimer
          : this.endpointTimer;
    if (handle) clearTimeout(handle);
    if (timer === 'connect') this.connectTimer = undefined;
    else if (timer === 'finish') this.finishTimer = undefined;
    else this.endpointTimer = undefined;
  }

  private closeSocket(): void {
    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(1000);
      }
    } catch {
      // Completion has already been committed.
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
}

function resolveOptions(
  options: AssemblyAiStreamingSttProviderOptions
): ResolvedAssemblyAiConfiguration {
  const apiKey = options.apiKey?.trim();
  if (
    !apiKey ||
    apiKey.length > 512 ||
    /[\s\r\n]/.test(apiKey)
  ) {
    throw new SttProviderError(
      'configuration',
      'AssemblyAI API key is required and must not contain whitespace',
      false
    );
  }

  const url = validateEndpoint(
    options.url ?? DEFAULT_URL,
    options.allowCustomEndpoint ?? false
  );
  const speechModel = options.speechModel ?? DEFAULT_MODEL;
  if (speechModel !== 'whisper-rt') {
    throw new SttProviderError(
      'configuration',
      'AssemblyAI whisper-rt model is required',
      false
    );
  }
  const minTurnSilenceMs = integerRange(
    options.minTurnSilenceMs,
    400,
    80,
    6_000,
    'minTurnSilenceMs'
  );
  const maxTurnSilenceMs = integerRange(
    options.maxTurnSilenceMs,
    1280,
    minTurnSilenceMs,
    10_000,
    'maxTurnSilenceMs'
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
  const forceEndpointTimeoutMs = positiveInteger(
    options.forceEndpointTimeoutMs,
    750,
    'forceEndpointTimeoutMs'
  );
  if (forceEndpointTimeoutMs >= finishTimeoutMs) {
    throw new SttProviderError(
      'configuration',
      'forceEndpointTimeoutMs must be less than finishTimeoutMs',
      false
    );
  }
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
    apiKey,
    options: Object.freeze({
      url,
      speechModel,
      minTurnSilenceMs,
      maxTurnSilenceMs,
      connectTimeoutMs,
      finishTimeoutMs,
      forceEndpointTimeoutMs,
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
      'AssemblyAI WebSocket endpoint is invalid',
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
      'AssemblyAI WebSocket endpoint must use authenticated WSS transport',
      false
    );
  }
  if (
    !allowCustomEndpoint &&
    (url.hostname !== 'streaming.assemblyai.com' ||
      url.pathname !== '/v3/ws' ||
      url.port !== '')
  ) {
    throw new SttProviderError(
      'configuration',
      'Custom AssemblyAI WebSocket endpoints require explicit opt-in',
      false
    );
  }
  return url.toString();
}

function buildConnectionUrl(options: ResolvedAssemblyAiOptions): string {
  const url = new URL(options.url);
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.set('encoding', 'pcm_mulaw');
  url.searchParams.set('speech_model', options.speechModel);
  url.searchParams.set('language_detection', 'true');
  url.searchParams.set('format_turns', 'true');
  url.searchParams.set(
    'min_turn_silence',
    String(options.minTurnSilenceMs)
  );
  url.searchParams.set(
    'max_turn_silence',
    String(options.maxTurnSilenceMs)
  );
  return url.toString();
}

function parseServerEvent(raw: RawData): AssemblyAiServerEvent | undefined {
  const value: unknown = JSON.parse(rawDataToUtf8(raw));
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new Error('invalid AssemblyAI message');
  }
  switch (value['type']) {
    case 'Begin':
      return {
        type: 'Begin',
        id: nonEmptyString(value['id']),
        expiresAt: nonNegativeFinite(value['expires_at']),
      };
    case 'Turn':
      return parseTurn(value);
    case 'Termination':
      return {
        type: 'Termination',
        audioDurationSeconds: nonNegativeFinite(
          value['audio_duration_seconds']
        ),
        sessionDurationSeconds: nonNegativeFinite(
          value['session_duration_seconds']
        ),
      };
    case 'Error':
      return {
        type: 'Error',
        code:
          typeof value['code'] === 'string'
            ? value['code']
            : undefined,
      };
    default:
      return undefined;
  }
}

function parseTurn(value: Record<string, unknown>): AssemblyAiTurn {
  const transcript = stringValue(value['transcript']);
  const utterance =
    value['utterance'] === undefined
      ? ''
      : stringValue(value['utterance']);
  if (
    transcript.length > MAX_TRANSCRIPT_CHARS ||
    utterance.length > MAX_TRANSCRIPT_CHARS
  ) {
    throw new Error('AssemblyAI transcript is too large');
  }
  return {
    type: 'Turn',
    turnOrder: nonNegativeInteger(value['turn_order']),
    turnIsFormatted: booleanValue(value['turn_is_formatted']),
    endOfTurn: booleanValue(value['end_of_turn']),
    transcript,
    utterance,
    endOfTurnConfidence:
      value['end_of_turn_confidence'] === undefined
        ? 0
        : probability(value['end_of_turn_confidence']),
    words: parseWords(value['words']),
    languageCode: optionalLanguageCode(value['language_code']),
  };
}

function parseWords(value: unknown): readonly SttWord[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_WORDS_PER_TURN
  ) {
    throw new Error('invalid AssemblyAI words');
  }
  return Object.freeze(
    value.map((item) => {
      if (!isRecord(item)) throw new Error('invalid AssemblyAI word');
      const start = nonNegativeFinite(item['start']);
      const end = nonNegativeFinite(item['end']);
      if (end < start) throw new Error('invalid AssemblyAI word window');
      if (item['word_is_final'] !== undefined) {
        booleanValue(item['word_is_final']);
      }
      return Object.freeze({
        text: stringValue(item['text']),
        confidence: probability(item['confidence']),
        startMs: Math.round(start),
        endMs: Math.round(end),
      });
    })
  );
}

function turnFingerprint(event: AssemblyAiTurn): string {
  return JSON.stringify([
    event.turnIsFormatted,
    event.endOfTurn,
    event.transcript,
    event.utterance,
    event.endOfTurnConfidence,
    event.words,
    event.languageCode,
  ]);
}

function rawDataToUtf8(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function rawDataByteLength(raw: RawData): number {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + part.length, 0);
  }
  return Buffer.byteLength(raw);
}

function isRetryableProviderCode(code: string | undefined): boolean {
  if (!code) return false;
  return new Set([
    'INTERNAL_SERVER_ERROR',
    'SERVICE_UNAVAILABLE',
    'TOO_MANY_REQUESTS',
    'RATE_LIMITED',
    'REQUEST_TIMEOUT',
    'TIMEOUT',
  ]).has(code.toUpperCase());
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

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('expected boolean');
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

function optionalLanguageCode(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value)
  ) {
    throw new Error('invalid language code');
  }
  return value;
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
