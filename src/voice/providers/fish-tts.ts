import { randomUUID } from 'crypto';
import type { ClientRequest, IncomingMessage } from 'http';
import { decode, encode } from '@msgpack/msgpack';
import WebSocket, {
  type ClientOptions as WebSocketClientOptions,
  type RawData,
} from 'ws';
import { sameTurn } from '../generation';
import {
  TtsProviderError,
  type CommittedSpeechSegment,
  type StreamingTtsProvider,
  type StreamingTtsSession,
  type TtsAudioFormat,
  type TtsSessionEvent,
  type TtsSessionOptions,
  type TtsSessionState,
  type TtsTerminal,
} from './tts';

const DEFAULT_URL = 'wss://api.fish.audio/v1/tts/live';
const DEFAULT_MODEL = 's2-pro';
const SUPPORTED_PCM_SAMPLE_RATES = new Set([8000, 16000, 24000, 32000, 44100]);

export type FishTtsLatency = 'low' | 'balanced' | 'normal';

export type FishWebSocketFactory = (
  url: string,
  options: WebSocketClientOptions
) => WebSocket;

export type FishTtsEventHandlerErrorContext = Readonly<{
  provider: 'fish-audio';
  eventType: TtsSessionEvent['type'];
  synthesisId: string;
  attemptId: string;
}>;

export type FishTtsProviderOptions = Readonly<{
  apiKey: string;
  url?: string;
  allowCustomEndpoint?: boolean;
  model?: string;
  referenceId?: string;
  latency?: FishTtsLatency;
  sampleRateHz?: number;
  chunkLength?: number;
  minChunkLength?: number;
  connectTimeoutMs?: number;
  firstAudioTimeoutMs?: number;
  finishTimeoutMs?: number;
  eventHandlerTimeoutMs?: number;
  maxSocketBufferedBytes?: number;
  maxAudioDurationMs?: number;
  maxIncomingFrameBytes?: number;
  webSocketFactory?: FishWebSocketFactory;
  now?: () => number;
  onEventHandlerError?: (
    error: unknown,
    context: FishTtsEventHandlerErrorContext
  ) => void;
}>;

type ResolvedFishOptions = Readonly<{
  apiKey: string;
  url: string;
  model: string;
  referenceId?: string;
  latency: FishTtsLatency;
  sampleRateHz: number;
  chunkLength: number;
  minChunkLength: number;
  connectTimeoutMs: number;
  firstAudioTimeoutMs: number;
  finishTimeoutMs: number;
  eventHandlerTimeoutMs: number;
  maxSocketBufferedBytes: number;
  maxAudioBytes: number;
  maxIncomingFrameBytes: number;
  webSocketFactory: FishWebSocketFactory;
  now: () => number;
  onEventHandlerError: (
    error: unknown,
    context: FishTtsEventHandlerErrorContext
  ) => void;
}>;

type FishServerEvent =
  | { event: 'audio'; audio: Uint8Array }
  | { event: 'finish'; reason: string };

/**
 * Direct Fish Audio live TTS adapter.
 *
 * It intentionally exposes PCM rather than μ-law. Telephony transcoding belongs
 * to VoiceRuntime, where the actually negotiated transport codec is known.
 */
export class FishTtsProvider implements StreamingTtsProvider {
  readonly name = 'fish-audio';
  readonly outputFormat: TtsAudioFormat;
  private readonly options: ResolvedFishOptions;

  constructor(options: FishTtsProviderOptions) {
    this.options = resolveOptions(options);
    this.outputFormat = Object.freeze({
      encoding: 'pcm_s16',
      sampleRateHz: this.options.sampleRateHz,
      channels: 1,
    });
  }

  async open(options: TtsSessionOptions): Promise<StreamingTtsSession> {
    validateTurn(options.turn);
    if (options.signal.aborted) {
      throw new TtsProviderError(
        'invalid_state',
        'TTS session was cancelled before opening',
        false
      );
    }

    const voiceId = options.voiceId?.trim() || this.options.referenceId;
    if (!voiceId) {
      throw new TtsProviderError(
        'configuration',
        'Fish Audio reference voice ID is required',
        false
      );
    }

    if (
      options.speed !== undefined &&
      (!Number.isFinite(options.speed) || options.speed < 0.5 || options.speed > 2)
    ) {
      throw new TtsProviderError(
        'configuration',
        'Fish Audio speech speed must be between 0.5 and 2',
        false
      );
    }

    let socket: WebSocket;
    try {
      socket = this.options.webSocketFactory(this.options.url, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          model: this.options.model,
        },
        maxPayload: this.options.maxIncomingFrameBytes,
        perMessageDeflate: false,
      });
    } catch {
      throw new TtsProviderError(
        'socket_error',
        'Unable to create Fish Audio WebSocket',
        true
      );
    }

    const session = new FishTtsSession(
      socket,
      options,
      voiceId,
      this.outputFormat,
      this.options
    );
    await session.waitUntilOpen();
    return session;
  }
}

class FishTtsSession implements StreamingTtsSession {
  readonly provider = 'fish-audio';
  readonly synthesisId = randomUUID();
  readonly attemptId = randomUUID();
  readonly turn: TtsSessionOptions['turn'];
  readonly closed: Promise<TtsTerminal>;

  private _state: TtsSessionState = 'opening';
  private readonly startedAtMs: number;
  private connectedAtMs: number | undefined;
  private firstTextAtMs: number | undefined;
  private firstAudioAtMs: number | undefined;
  private nextSegmentSequence = 0;
  private nextAudioSequence = 0;
  private audioBytes = 0;
  private audioChunks = 0;
  private providerFinished = false;
  private terminal: TtsTerminal | undefined;
  private resolveClosed!: (terminal: TtsTerminal) => void;
  private resolveOpen!: () => void;
  private rejectOpen!: (error: Error) => void;
  private readonly openPromise: Promise<void>;
  private connectTimer: NodeJS.Timeout | undefined;
  private firstAudioTimer: NodeJS.Timeout | undefined;
  private finishTimer: NodeJS.Timeout | undefined;
  private eventChain: Promise<void> = Promise.resolve();
  private readonly deliveryController = new AbortController();
  private deliveryCompromised = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly sessionOptions: TtsSessionOptions,
    private readonly voiceId: string,
    private readonly format: TtsAudioFormat,
    private readonly providerOptions: ResolvedFishOptions
  ) {
    this.turn = sessionOptions.turn;
    this.startedAtMs = providerOptions.now();
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.closed = new Promise<TtsTerminal>((resolve) => {
      this.resolveClosed = resolve;
    });

    this.socket.on('open', this.handleOpen);
    this.socket.on('message', this.handleMessage);
    this.socket.on('error', this.handleSocketError);
    this.socket.on('close', this.handleSocketClose);
    this.socket.on('unexpected-response', this.handleUnexpectedResponse);
    this.sessionOptions.signal.addEventListener('abort', this.handleAbort, {
      once: true,
    });

    this.connectTimer = setTimeout(() => {
      this.fail(
        new TtsProviderError(
          'connection_timeout',
          'Fish Audio connection timed out',
          true
        )
      );
    }, this.providerOptions.connectTimeoutMs);
  }

  get state(): TtsSessionState {
    return this._state;
  }

  waitUntilOpen(): Promise<void> {
    return this.openPromise;
  }

  async write(segment: CommittedSpeechSegment): Promise<void> {
    this.assertOpen('write');
    this.validateSegment(segment);

    this.sendFrame({ event: 'text', text: segment.text }, true);
    this.firstTextAtMs ??= this.providerOptions.now();
    this.nextSegmentSequence++;
    this.emit({
      ...this.eventBase(),
      type: 'segment_accepted',
      segmentSequence: segment.sequence,
      characterCount: segment.text.length,
    });
  }

  async flush(): Promise<void> {
    this.assertOpen('flush');
    this.sendFrame({ event: 'flush' });
    this.armFirstAudioTimeout();
  }

  async finish(): Promise<TtsTerminal> {
    if (this.terminal) return this.terminal;
    if (this._state === 'finishing') return this.closed;
    this.assertOpen('finish');

    this._state = 'finishing';
    try {
      this.sendFrame({ event: 'stop' });
    } catch {
      return this.closed;
    }
    this.armFirstAudioTimeout();
    this.finishTimer = setTimeout(() => {
      this.fail(
        new TtsProviderError(
          'finish_timeout',
          'Fish Audio did not finish the session in time',
          this.firstAudioAtMs === undefined
        )
      );
    }, this.providerOptions.finishTimeoutMs);
    return this.closed;
  }

  private readonly handleOpen = (): void => {
    if (this._state !== 'opening') return;

    this.clearTimer('connect');
    this.connectedAtMs = this.providerOptions.now();
    const request: Record<string, unknown> = {
      text: '',
      format: 'pcm',
      sample_rate: this.format.sampleRateHz,
      reference_id: this.voiceId,
      latency: this.providerOptions.latency,
      chunk_length: this.providerOptions.chunkLength,
      min_chunk_length: this.providerOptions.minChunkLength,
      normalize: true,
      condition_on_previous_chunks: true,
    };
    if (this.sessionOptions.speed !== undefined) {
      request['prosody'] = {
        speed: this.sessionOptions.speed,
        volume: 0,
      };
    }

    try {
      this.sendFrame({ event: 'start', request });
    } catch {
      return;
    }

    this._state = 'open';
    this.resolveOpen();
    this.emit({
      ...this.eventBase(),
      type: 'session_started',
      connectMs: this.connectedAtMs - this.startedAtMs,
      format: this.format,
    });
  };

  private readonly handleMessage = (raw: RawData): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;

    let event: FishServerEvent | undefined;
    try {
      event = parseServerEvent(raw);
    } catch {
      this.fail(
        new TtsProviderError(
          'protocol_error',
          'Fish Audio returned an invalid MessagePack frame',
          false
        )
      );
      return;
    }

    if (!event) return;

    if (event.event === 'audio') {
      this.handleAudio(event.audio);
      return;
    }

    if (event.reason !== 'stop') {
      this.fail(
        new TtsProviderError(
          'provider_error',
          'Fish Audio reported a synthesis error',
          this.firstAudioAtMs === undefined
        )
      );
    } else if (this._state !== 'finishing') {
      this.fail(
        new TtsProviderError(
          'protocol_error',
          'Fish Audio finished before the client ended the session',
          false
        )
      );
    } else if (event.reason === 'stop') {
      if (this.firstTextAtMs !== undefined && this.audioBytes === 0) {
        this.fail(
          new TtsProviderError(
            'first_audio_timeout',
            'Fish Audio finished without returning audio',
            true
          )
        );
        return;
      }
      this.complete();
    }
  };

  private readonly handleSocketError = (): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    this.fail(
      new TtsProviderError(
        'socket_error',
        'Fish Audio WebSocket error',
        this.firstAudioAtMs === undefined
      )
    );
  };

  private readonly handleSocketClose = (code: number): void => {
    if (isTerminalState(this._state) || this.providerFinished) return;
    this.fail(
      new TtsProviderError(
        'unexpected_close',
        `Fish Audio WebSocket closed before completion (code ${code})`,
        this.firstAudioAtMs === undefined
      )
    );
  };

  private readonly handleUnexpectedResponse = (
    _request: ClientRequest,
    response: IncomingMessage
  ): void => {
    if (isTerminalState(this._state)) return;
    const status = response.statusCode ?? 0;
    const isRateLimit = status === 429;
    const isServerFailure = status >= 500 && status <= 599;
    const isConfigurationFailure =
      status === 400 ||
      status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 404 ||
      status === 422;
    this.fail(
      new TtsProviderError(
        isConfigurationFailure ? 'configuration' : 'socket_error',
        `Fish Audio WebSocket handshake failed (status ${status || 'unknown'})`,
        isRateLimit || isServerFailure
      )
    );
  };

  private readonly handleAbort = (): void => {
    if (this.terminal) return;
    const reason = abortReason(this.sessionOptions.signal);
    const wasOpening = this._state === 'opening';
    this._state = 'cancelled';
    this.deliveryController.abort(reason);
    const terminal: TtsTerminal = Object.freeze({
      status: 'cancelled',
      reason,
      audioBytes: this.audioBytes,
      audioChunks: this.audioChunks,
      totalMs: this.elapsedMs(),
    });
    this.commitTerminal(terminal);
    if (wasOpening) {
      void this.closed.finally(() => {
        this.rejectOpen(
          new TtsProviderError(
            'invalid_state',
            'TTS session was cancelled before opening',
            false
          )
        );
      });
    }
    this.terminateSocket();
  };

  private handleAudio(bytes: Uint8Array): void {
    if (this._state !== 'open' && this._state !== 'finishing') return;
    if (bytes.byteLength === 0) return;

    if (this.audioBytes + bytes.byteLength > this.providerOptions.maxAudioBytes) {
      this.fail(
        new TtsProviderError(
          'audio_limit_exceeded',
          'Fish Audio session exceeded the configured audio byte limit',
          false
        )
      );
      return;
    }

    const receivedAtMs = this.providerOptions.now();
    const firstAudioMs =
      this.firstAudioAtMs === undefined
        ? receivedAtMs - (this.firstTextAtMs ?? this.connectedAtMs ?? this.startedAtMs)
        : undefined;

    if (this.firstAudioAtMs === undefined) {
      this.firstAudioAtMs = receivedAtMs;
      this.clearTimer('firstAudio');
    }

    const data = Buffer.from(bytes);
    this.audioBytes += data.length;
    this.audioChunks++;
    this.emit({
      ...this.eventBase(),
      type: 'audio',
      sequence: this.nextAudioSequence++,
      data,
      format: this.format,
      ...(firstAudioMs === undefined ? {} : { firstAudioMs }),
    });
  }

  private validateSegment(segment: CommittedSpeechSegment): void {
    if (segment.kind !== 'committed') {
      throw this.invalidSegment('Only committed speech segments can be synthesized');
    }
    if (!sameTurn(this.turn, segment.turn)) {
      throw this.invalidSegment('Speech segment belongs to a different turn or generation');
    }
    if (segment.sequence !== this.nextSegmentSequence) {
      throw this.invalidSegment(
        `Expected speech segment ${this.nextSegmentSequence}, received ${segment.sequence}`
      );
    }
    if (!segment.text.trim()) {
      throw this.invalidSegment('Speech segment text cannot be empty');
    }
  }

  private invalidSegment(message: string): TtsProviderError {
    return new TtsProviderError('invalid_segment', message, false);
  }

  private assertOpen(operation: string): void {
    if (this._state !== 'open') {
      throw new TtsProviderError(
        'invalid_state',
        `Cannot ${operation} while TTS session is ${this._state}`,
        false
      );
    }
  }

  private sendFrame(
    value: Record<string, unknown>,
    enforceBackpressure = false
  ): void {
    const frame = encode(value);
    if (
      enforceBackpressure &&
      this.socket.bufferedAmount + frame.byteLength >
        this.providerOptions.maxSocketBufferedBytes
    ) {
      throw new TtsProviderError(
        'backpressure',
        'Fish Audio WebSocket send buffer is full',
        true
      );
    }

    try {
      this.socket.send(frame);
    } catch {
      const error = new TtsProviderError(
        'socket_error',
        'Unable to send data to Fish Audio',
        this.firstAudioAtMs === undefined
      );
      this.fail(error);
      throw error;
    }
  }

  private armFirstAudioTimeout(): void {
    if (
      this.firstAudioAtMs !== undefined ||
      this.firstTextAtMs === undefined ||
      this.firstAudioTimer
    ) {
      return;
    }

    this.firstAudioTimer = setTimeout(() => {
      this.fail(
        new TtsProviderError(
          'first_audio_timeout',
          'Fish Audio did not return audio in time',
          this.firstAudioAtMs === undefined
        )
      );
    }, this.providerOptions.firstAudioTimeoutMs);
  }

  private complete(): void {
    if (this.terminal || this.providerFinished) return;
    this.providerFinished = true;
    this.clearTimer('firstAudio');
    this.clearTimer('finish');
    this.closeSocket(1000, 'complete');

    // Provider completion is not enough: all previously queued audio must reach
    // the consumer before the public session can be marked completed.
    const pendingDelivery = this.eventChain;
    void pendingDelivery.then(() => {
      if (this.terminal) return;
      this._state = 'completed';
      const terminal: TtsTerminal = Object.freeze({
        status: 'completed',
        audioBytes: this.audioBytes,
        audioChunks: this.audioChunks,
        totalMs: this.elapsedMs(),
      });
      this.commitTerminal(terminal);
    });
  }

  private fail(error: TtsProviderError): void {
    if (this.terminal) return;
    const wasOpening = this._state === 'opening';
    this._state = 'failed';
    this.deliveryController.abort(error.code);
    const terminal: TtsTerminal = Object.freeze({
      status: 'failed',
      error,
      audioStarted: this.firstAudioAtMs !== undefined,
      audioBytes: this.audioBytes,
      audioChunks: this.audioChunks,
      totalMs: this.elapsedMs(),
    });
    this.commitTerminal(terminal, error);
    if (wasOpening) {
      void this.closed.finally(() => {
        this.rejectOpen(error);
      });
    }
    this.terminateSocket();
  }

  private commitTerminal(
    terminal: TtsTerminal,
    error?: TtsProviderError
  ): void {
    if (this.terminal) return;
    this.terminal = terminal;
    this.clearTimer('connect');
    this.clearTimer('firstAudio');
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
      synthesisId: this.synthesisId,
      attemptId: this.attemptId,
      provider: this.provider,
      turn: this.turn,
      timestampMs: this.providerOptions.now(),
      signal: this.deliveryController.signal,
    } as const;
  }

  private emit(event: TtsSessionEvent): Promise<void> {
    this.eventChain = this.eventChain
      .then(async () => {
        if (
          event.type === 'audio' &&
          (this.deliveryCompromised ||
            this._state === 'cancelled' ||
            this._state === 'failed')
        ) {
          return;
        }
        await this.deliverEvent(event);
      });
    return this.eventChain;
  }

  private deliverEvent(event: TtsSessionEvent): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.deliveryCompromised = true;
        this.deliveryController.abort('event-handler-timeout');
        this.reportEventHandlerError(
          new Error('TTS event handler timed out'),
          event
        );
        this.fail(
          new TtsProviderError(
            'backpressure',
            'TTS event handler timed out',
            false
          )
        );
        finish();
      }, this.providerOptions.eventHandlerTimeoutMs);

      try {
        void Promise.resolve(this.sessionOptions.onEvent(event))
          .catch((error) => {
            if (settled) return;
            this.reportEventHandlerError(error, event);
            if (event.type === 'audio') {
              this.deliveryCompromised = true;
              this.deliveryController.abort('event-handler-error');
              this.fail(
                new TtsProviderError(
                  'backpressure',
                  'TTS audio delivery handler failed',
                  false
                )
              );
            }
          })
          .finally(finish);
      } catch (error) {
        this.reportEventHandlerError(error, event);
        if (event.type === 'audio') {
          this.deliveryCompromised = true;
          this.deliveryController.abort('event-handler-error');
          this.fail(
            new TtsProviderError(
              'backpressure',
              'TTS audio delivery handler failed',
              false
            )
          );
        }
        finish();
      }
    });
  }

  private reportEventHandlerError(error: unknown, event: TtsSessionEvent): void {
    try {
      this.providerOptions.onEventHandlerError(error, {
        provider: 'fish-audio',
        eventType: event.type,
        synthesisId: this.synthesisId,
        attemptId: this.attemptId,
      });
    } catch {
      // Observability must never destabilize the synthesis state machine.
    }
  }

  private elapsedMs(): number {
    return this.providerOptions.now() - this.startedAtMs;
  }

  private closeSocket(code: number, reason: string): void {
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close(code, reason);
      }
    } catch {
      this.socket.terminate();
    }
  }

  private terminateSocket(): void {
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.CLOSING
      ) {
        this.socket.terminate();
      }
    } catch {
      // Local terminal state is authoritative even if transport cleanup fails.
    }
  }

  private clearTimer(timer: 'connect' | 'firstAudio' | 'finish'): void {
    const value =
      timer === 'connect'
        ? this.connectTimer
        : timer === 'firstAudio'
          ? this.firstAudioTimer
          : this.finishTimer;
    if (value) clearTimeout(value);
    if (timer === 'connect') this.connectTimer = undefined;
    if (timer === 'firstAudio') this.firstAudioTimer = undefined;
    if (timer === 'finish') this.finishTimer = undefined;
  }
}

function resolveOptions(options: FishTtsProviderOptions): ResolvedFishOptions {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio API key is required',
      false
    );
  }

  const url = validateEndpoint(
    options.url?.trim() || DEFAULT_URL,
    options.allowCustomEndpoint ?? false
  );
  const model = options.model?.trim() || DEFAULT_MODEL;
  if (!model) {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio model is required',
      false
    );
  }

  const sampleRateHz = options.sampleRateHz ?? 8000;
  if (!SUPPORTED_PCM_SAMPLE_RATES.has(sampleRateHz)) {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio PCM sample rate is not supported',
      false
    );
  }

  const chunkLength = options.chunkLength ?? 100;
  if (!Number.isInteger(chunkLength) || chunkLength < 100 || chunkLength > 300) {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio chunk length must be an integer between 100 and 300',
      false
    );
  }

  const minChunkLength = options.minChunkLength ?? 50;
  if (
    !Number.isInteger(minChunkLength) ||
    minChunkLength < 0 ||
    minChunkLength > 100
  ) {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio minimum chunk length must be an integer between 0 and 100',
      false
    );
  }

  return {
    apiKey,
    url,
    model,
    referenceId: options.referenceId?.trim() || undefined,
    latency: options.latency ?? 'balanced',
    sampleRateHz,
    chunkLength,
    minChunkLength,
    connectTimeoutMs: positiveNumber(
      options.connectTimeoutMs,
      10_000,
      'connection timeout'
    ),
    firstAudioTimeoutMs: positiveNumber(
      options.firstAudioTimeoutMs,
      5_000,
      'first audio timeout'
    ),
    finishTimeoutMs: positiveNumber(
      options.finishTimeoutMs,
      10_000,
      'finish timeout'
    ),
    eventHandlerTimeoutMs: positiveNumber(
      options.eventHandlerTimeoutMs,
      2_000,
      'event handler timeout'
    ),
    maxSocketBufferedBytes: positiveNumber(
      options.maxSocketBufferedBytes,
      256 * 1024,
      'WebSocket buffer limit'
    ),
    maxAudioBytes: Math.ceil(
      sampleRateHz *
        2 *
        (positiveNumber(
          options.maxAudioDurationMs,
          120_000,
          'audio duration limit'
        ) /
          1000)
    ),
    maxIncomingFrameBytes: positiveNumber(
      options.maxIncomingFrameBytes,
      512 * 1024,
      'incoming frame limit'
    ),
    webSocketFactory:
      options.webSocketFactory ??
      ((socketUrl, socketOptions) => new WebSocket(socketUrl, socketOptions)),
    now: options.now ?? Date.now,
    onEventHandlerError: options.onEventHandlerError ?? (() => undefined),
  };
}

function positiveNumber(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TtsProviderError(
      'configuration',
      `Fish Audio ${label} must be greater than zero`,
      false
    );
  }
  return resolved;
}

function validateEndpoint(value: string, allowCustomEndpoint: boolean): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio endpoint must be a valid URL',
      false
    );
  }

  if (endpoint.protocol !== 'wss:') {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio endpoint must use encrypted wss:// transport',
      false
    );
  }
  if (endpoint.username || endpoint.password) {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio endpoint must not contain URL credentials',
      false
    );
  }
  if (!allowCustomEndpoint && endpoint.hostname !== 'api.fish.audio') {
    throw new TtsProviderError(
      'configuration',
      'Fish Audio endpoint host must be api.fish.audio',
      false
    );
  }
  return endpoint.toString();
}

function validateTurn(turn: TtsSessionOptions['turn']): void {
  if (
    !turn.callId.trim() ||
    !turn.conversationId.trim() ||
    !turn.turnId.trim() ||
    !Number.isInteger(turn.generation) ||
    turn.generation < 1
  ) {
    throw new TtsProviderError(
      'configuration',
      'A valid call, conversation, turn and generation are required',
      false
    );
  }
}

function parseServerEvent(raw: RawData): FishServerEvent | undefined {
  const decoded = decode(rawDataToBytes(raw));
  if (!isRecord(decoded) || typeof decoded['event'] !== 'string') {
    throw new Error('Invalid Fish Audio event');
  }

  if (decoded['event'] === 'audio') {
    const audio = decoded['audio'];
    if (!(audio instanceof Uint8Array)) {
      throw new Error('Invalid Fish Audio audio event');
    }
    return { event: 'audio', audio };
  }

  if (decoded['event'] === 'finish') {
    return {
      event: 'finish',
      reason: typeof decoded['reason'] === 'string' ? decoded['reason'] : 'error',
    };
  }

  // The protocol may gain non-audio informational events. Ignore them safely.
  return undefined;
}

function rawDataToBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return new Uint8Array(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalState(state: TtsSessionState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'failed';
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason.trim()
    ? signal.reason
    : 'cancelled';
}
