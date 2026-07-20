export type SttStreamRef = Readonly<{
  callId: string;
  conversationId: string;
}>;

export type SttAudioFormat = Readonly<{
  encoding: 'mulaw';
  sampleRateHz: 8000;
  channels: 1;
}>;

export type SttFailureCode =
  | 'configuration'
  | 'connection_timeout'
  | 'finish_timeout'
  | 'socket_error'
  | 'unexpected_close'
  | 'provider_error'
  | 'protocol_error'
  | 'invalid_state'
  | 'backpressure'
  | 'audio_limit_exceeded';

export class SttProviderError extends Error {
  constructor(
    public readonly code: SttFailureCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'SttProviderError';
  }
}

export type SttTurnEventKind =
  | 'update'
  | 'start_of_turn'
  | 'eager_end_of_turn'
  | 'turn_resumed'
  | 'end_of_turn';

export type SttWord = Readonly<{
  text: string;
  confidence: number;
  startMs?: number;
  endMs?: number;
}>;

export type SttTurnSnapshot = Readonly<{
  kind: SttTurnEventKind;
  turnIndex: number;
  transcript: string;
  words: readonly SttWord[];
  audioWindowStartMs: number;
  audioWindowEndMs: number;
  endOfTurnConfidence: number;
  /**
   * `eager_end_of_turn` is deliberately not final: downstream work based on it
   * must remain cancellable until a matching `end_of_turn` arrives.
   */
  isFinal: boolean;
  isSpeculative: boolean;
  requestId: string;
  serverSequence: number;
  languages: readonly string[];
  languagesHinted: readonly string[];
}>;

export type SttTerminal =
  | Readonly<{
      status: 'completed';
      audioBytes: number;
      audioFrames: number;
      turnsCompleted: number;
      totalMs: number;
    }>
  | Readonly<{
      status: 'cancelled';
      reason: string;
      audioBytes: number;
      audioFrames: number;
      turnsCompleted: number;
      totalMs: number;
    }>
  | Readonly<{
      status: 'failed';
      error: SttProviderError;
      audioStarted: boolean;
      audioBytes: number;
      audioFrames: number;
      turnsCompleted: number;
      totalMs: number;
    }>;

type SttEventBase = Readonly<{
  transcriptionId: string;
  attemptId: string;
  provider: string;
  stream: SttStreamRef;
  timestampMs: number;
  /** Aborted when transcript delivery must stop or the stream is invalidated. */
  signal: AbortSignal;
}>;

export type SttSessionEvent =
  | (SttEventBase &
      Readonly<{
        type: 'session_started';
        requestId: string;
        connectMs: number;
        format: SttAudioFormat;
      }>)
  | (SttEventBase &
      Readonly<{
        type: 'turn';
        turn: SttTurnSnapshot;
      }>)
  | (SttEventBase &
      Readonly<{
        type: 'error';
        error: SttProviderError;
      }>)
  | (SttEventBase &
      Readonly<{
        type: 'terminal';
        terminal: SttTerminal;
      }>);

export type SttSessionEventHandler = (
  event: SttSessionEvent
) => void | Promise<void>;

export type SttSessionState =
  | 'opening'
  | 'open'
  | 'finishing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type SttSessionOptions = Readonly<{
  stream: SttStreamRef;
  signal: AbortSignal;
  onEvent: SttSessionEventHandler;
}>;

export interface StreamingSttSession {
  readonly provider: string;
  readonly transcriptionId: string;
  readonly attemptId: string;
  readonly stream: SttStreamRef;
  readonly state: SttSessionState;
  readonly closed: Promise<SttTerminal>;

  /**
   * Accepts raw mono μ-law at 8 kHz. Implementations may buffer input to reach
   * the provider's preferred wire-frame duration.
   */
  writeAudio(audio: Buffer): Promise<void>;
  /**
   * Flushes the last partial audio frame, requests a graceful provider close,
   * and resolves only after all final transcript events have been delivered.
   */
  finish(): Promise<SttTerminal>;
}

export interface StreamingSttProvider {
  readonly name: string;
  readonly inputFormat: SttAudioFormat;

  open(options: SttSessionOptions): Promise<StreamingSttSession>;
}
