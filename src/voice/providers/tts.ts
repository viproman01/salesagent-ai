export type TurnRef = Readonly<{
  callId: string;
  conversationId: string;
  turnId: string;
  generation: number;
}>;

export type CommittedSpeechSegment = Readonly<{
  kind: 'committed';
  turn: TurnRef;
  sequence: number;
  text: string;
}>;

export type TtsAudioFormat = Readonly<{
  encoding: 'pcm_s16';
  sampleRateHz: number;
  channels: 1;
}>;

export type TtsFailureCode =
  | 'configuration'
  | 'connection_timeout'
  | 'first_audio_timeout'
  | 'finish_timeout'
  | 'socket_error'
  | 'unexpected_close'
  | 'provider_error'
  | 'protocol_error'
  | 'invalid_state'
  | 'invalid_segment'
  | 'backpressure'
  | 'audio_limit_exceeded';

export class TtsProviderError extends Error {
  constructor(
    public readonly code: TtsFailureCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'TtsProviderError';
  }
}

export type TtsTerminal =
  | Readonly<{
      status: 'completed';
      audioBytes: number;
      audioChunks: number;
      totalMs: number;
    }>
  | Readonly<{
      status: 'cancelled';
      reason: string;
      audioBytes: number;
      audioChunks: number;
      totalMs: number;
    }>
  | Readonly<{
      status: 'failed';
      error: TtsProviderError;
      audioStarted: boolean;
      audioBytes: number;
      audioChunks: number;
      totalMs: number;
    }>;

type TtsEventBase = Readonly<{
  synthesisId: string;
  attemptId: string;
  provider: string;
  turn: TurnRef;
  timestampMs: number;
  /** Aborted when delivery must stop (barge-in, failure, or handler timeout). */
  signal: AbortSignal;
}>;

export type TtsSessionEvent =
  | (TtsEventBase &
      Readonly<{
        type: 'session_started';
        connectMs: number;
        format: TtsAudioFormat;
      }>)
  | (TtsEventBase &
      Readonly<{
        type: 'segment_accepted';
        segmentSequence: number;
        characterCount: number;
      }>)
  | (TtsEventBase &
      Readonly<{
        type: 'audio';
        sequence: number;
        data: Buffer;
        format: TtsAudioFormat;
        firstAudioMs?: number;
      }>)
  | (TtsEventBase &
      Readonly<{
        type: 'error';
        error: TtsProviderError;
      }>)
  | (TtsEventBase &
      Readonly<{
        type: 'terminal';
        terminal: TtsTerminal;
      }>);

export type TtsSessionEventHandler = (
  event: TtsSessionEvent
) => void | Promise<void>;

export type TtsSessionState =
  | 'opening'
  | 'open'
  | 'finishing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type TtsSessionOptions = Readonly<{
  turn: TurnRef;
  voiceId?: string;
  speed?: number;
  signal: AbortSignal;
  onEvent: TtsSessionEventHandler;
}>;

export interface StreamingTtsSession {
  readonly provider: string;
  readonly synthesisId: string;
  readonly attemptId: string;
  readonly turn: TurnRef;
  readonly state: TtsSessionState;
  readonly closed: Promise<TtsTerminal>;

  write(segment: CommittedSpeechSegment): Promise<void>;
  flush(): Promise<void>;
  finish(): Promise<TtsTerminal>;
}

export interface StreamingTtsProvider {
  readonly name: string;
  readonly outputFormat: TtsAudioFormat;

  open(options: TtsSessionOptions): Promise<StreamingTtsSession>;
}
