import {
  SttProviderError,
  type StreamingSttProvider,
  type StreamingSttSession,
  type SttAudioFormat,
  type SttSessionEvent,
  type SttSessionOptions,
} from './stt';

export type ColdFallbackSttContext = Readonly<{
  primary: string;
  fallback: string;
  errorCode: SttProviderError['code'];
}>;

export type ColdFallbackSttProviderOptions = Readonly<{
  primary: StreamingSttProvider;
  fallback: StreamingSttProvider;
  maxPendingPrimaryEvents?: number;
  shouldFallback?: (error: SttProviderError) => boolean;
  onFallback?: (context: ColdFallbackSttContext) => void;
}>;

/**
 * Falls back only while opening the primary session, before callers can submit
 * audio. Once `open()` returns a session, ownership is permanently committed
 * to that provider. This deliberately avoids replaying accepted audio or
 * transcript events, which would otherwise risk duplicated user turns.
 */
export class ColdFallbackStreamingSttProvider
  implements StreamingSttProvider
{
  readonly name: string;
  readonly inputFormat: SttAudioFormat;

  private readonly primary: StreamingSttProvider;
  private readonly fallback: StreamingSttProvider;
  private readonly maxPendingPrimaryEvents: number;
  private readonly shouldFallback: (error: SttProviderError) => boolean;
  private readonly onFallback: (context: ColdFallbackSttContext) => void;

  constructor(options: ColdFallbackSttProviderOptions) {
    assertMatchingFormats(
      options.primary.inputFormat,
      options.fallback.inputFormat
    );
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.name = `cold-fallback(${this.primary.name},${this.fallback.name})`;
    this.inputFormat = Object.freeze({ ...this.primary.inputFormat });
    this.maxPendingPrimaryEvents = positiveInteger(
      options.maxPendingPrimaryEvents,
      8,
      'maxPendingPrimaryEvents'
    );
    this.shouldFallback =
      options.shouldFallback ?? defaultShouldFallback;
    this.onFallback = options.onFallback ?? (() => undefined);
  }

  async open(options: SttSessionOptions): Promise<StreamingSttSession> {
    if (options.signal.aborted) {
      throw new SttProviderError(
        'invalid_state',
        'STT stream was cancelled before opening',
        false
      );
    }

    let selectionState:
      | 'probing'
      | 'flushing'
      | 'primary'
      | 'discard' = 'probing';
    const pendingPrimaryEvents: SttSessionEvent[] = [];
    let primaryTurnObserved = false;
    let bufferFailure: SttProviderError | undefined;

    const primaryOptions: SttSessionOptions = {
      ...options,
      onEvent: async (event: SttSessionEvent) => {
        if (event.type === 'turn') primaryTurnObserved = true;
        if (
          selectionState === 'probing' ||
          selectionState === 'flushing'
        ) {
          if (
            pendingPrimaryEvents.length >=
            this.maxPendingPrimaryEvents
          ) {
            bufferFailure ??= new SttProviderError(
              'backpressure',
              'Primary STT selection event queue is full',
              false
            );
            throw bufferFailure;
          }
          pendingPrimaryEvents.push(event);
          return;
        }
        if (selectionState === 'primary') {
          await options.onEvent(event);
        }
      },
    };

    try {
      const session = await this.primary.open(primaryOptions);
      if (bufferFailure) {
        selectionState = 'discard';
        safelyFinish(session);
        throw bufferFailure;
      }
      selectionState = 'flushing';
      try {
        while (pendingPrimaryEvents.length > 0) {
          const event = pendingPrimaryEvents.shift()!;
          await options.onEvent(event);
          if (bufferFailure) throw bufferFailure;
        }
      } catch (error) {
        selectionState = 'discard';
        safelyFinish(session);
        throw normalizeDeliveryError(error);
      }
      selectionState = 'primary';
      return session;
    } catch (error) {
      selectionState = 'discard';
      const providerError = normalizeProviderError(error);
      if (
        bufferFailure ||
        options.signal.aborted ||
        primaryTurnObserved ||
        !this.shouldFallback(providerError)
      ) {
        throw providerError;
      }
      this.reportFallback(providerError);
      return this.fallback.open(options);
    }
  }

  private reportFallback(error: SttProviderError): void {
    try {
      this.onFallback({
        primary: this.primary.name,
        fallback: this.fallback.name,
        errorCode: error.code,
      });
    } catch {
      // Observability must not prevent the deterministic fallback.
    }
  }
}

function defaultShouldFallback(error: SttProviderError): boolean {
  return (
    error.retryable &&
    (error.code === 'connection_timeout' ||
      error.code === 'socket_error' ||
      error.code === 'unexpected_close' ||
      error.code === 'provider_error')
  );
}

function normalizeProviderError(error: unknown): SttProviderError {
  if (error instanceof SttProviderError) return error;
  return new SttProviderError(
    'socket_error',
    'Primary STT provider failed while opening',
    true,
    error instanceof Error ? { cause: error } : undefined
  );
}

function assertMatchingFormats(
  primary: SttAudioFormat,
  fallback: SttAudioFormat
): void {
  if (
    primary.encoding !== fallback.encoding ||
    primary.sampleRateHz !== fallback.sampleRateHz ||
    primary.channels !== fallback.channels
  ) {
    throw new SttProviderError(
      'configuration',
      'Primary and fallback STT providers must use the same audio format',
      false
    );
  }
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

function normalizeDeliveryError(error: unknown): SttProviderError {
  if (error instanceof SttProviderError) return error;
  return new SttProviderError(
    'backpressure',
    'STT event delivery failed while selecting a provider',
    false,
    error instanceof Error ? { cause: error } : undefined
  );
}

function safelyFinish(session: StreamingSttSession): void {
  try {
    void session.finish().catch(() => undefined);
  } catch {
    // The failed selection has already been isolated from the caller.
  }
}
