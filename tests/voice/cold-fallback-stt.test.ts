import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ColdFallbackStreamingSttProvider,
  type ColdFallbackSttContext,
} from '../../src/voice/providers/cold-fallback-stt';
import {
  SttProviderError,
  type StreamingSttProvider,
  type StreamingSttSession,
  type SttAudioFormat,
  type SttSessionEvent,
  type SttSessionOptions,
  type SttTerminal,
} from '../../src/voice/providers/stt';

const PHONE_FORMAT: SttAudioFormat = Object.freeze({
  encoding: 'mulaw',
  sampleRateHz: 8000,
  channels: 1,
});

const COMPLETED: SttTerminal = Object.freeze({
  status: 'completed',
  audioBytes: 0,
  audioFrames: 0,
  turnsCompleted: 0,
  totalMs: 0,
});

class FakeSession implements StreamingSttSession {
  readonly provider: string;
  readonly transcriptionId: string;
  readonly attemptId: string;
  readonly stream = {
    callId: 'call-1',
    conversationId: 'conversation-1',
  };
  readonly state = 'completed' as const;
  readonly closed = Promise.resolve(COMPLETED);

  constructor(provider: string) {
    this.provider = provider;
    this.transcriptionId = `${provider}-transcription`;
    this.attemptId = `${provider}-attempt`;
  }

  async writeAudio(_audio: Buffer): Promise<void> {}

  async finish(): Promise<SttTerminal> {
    return COMPLETED;
  }
}

class FakeProvider implements StreamingSttProvider {
  readonly inputFormat: SttAudioFormat;
  opens = 0;

  constructor(
    readonly name: string,
    private readonly openImplementation: (
      options: SttSessionOptions
    ) => Promise<StreamingSttSession>,
    format: SttAudioFormat = PHONE_FORMAT
  ) {
    this.inputFormat = format;
  }

  open(options: SttSessionOptions): Promise<StreamingSttSession> {
    this.opens++;
    return this.openImplementation(options);
  }
}

function sessionStarted(
  provider: string,
  signal: AbortSignal
): SttSessionEvent {
  return {
    type: 'session_started',
    transcriptionId: `${provider}-transcription`,
    attemptId: `${provider}-attempt`,
    provider,
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    timestampMs: 0,
    signal,
    requestId: `${provider}-request`,
    connectMs: 1,
    format: PHONE_FORMAT,
  };
}

function turnEvent(
  provider: string,
  signal: AbortSignal
): SttSessionEvent {
  return {
    type: 'turn',
    transcriptionId: `${provider}-transcription`,
    attemptId: `${provider}-attempt`,
    provider,
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    timestampMs: 0,
    signal,
    turn: {
      kind: 'end_of_turn',
      turnIndex: 0,
      transcript: 'hello',
      words: [],
      audioWindowStartMs: 0,
      audioWindowEndMs: 0,
      endOfTurnConfidence: 1,
      isFinal: true,
      isSpeculative: false,
      requestId: `${provider}-request`,
      serverSequence: 0,
      languages: ['en'],
      languagesHinted: [],
    },
  };
}

function openOptions(
  events: SttSessionEvent[],
  controller = new AbortController()
): SttSessionOptions {
  return {
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
    },
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('falls back on retryable primary open failure without leaking primary events', async () => {
  const events: SttSessionEvent[] = [];
  let primaryDelivery: Promise<void> | undefined;
  const primary = new FakeProvider('primary', async (options) => {
    primaryDelivery = Promise.resolve(
      options.onEvent(sessionStarted('primary', options.signal))
    );
    throw new SttProviderError(
      'connection_timeout',
      'primary timeout',
      true
    );
  });
  const fallback = new FakeProvider('fallback', async (options) => {
    await options.onEvent(sessionStarted('fallback', options.signal));
    return new FakeSession('fallback');
  });
  const fallbackContexts: ColdFallbackSttContext[] = [];
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
    onFallback: (context) => fallbackContexts.push(context),
  });

  const session = await provider.open(openOptions(events));
  await primaryDelivery;

  assert.equal(session.provider, 'fallback');
  assert.equal(primary.opens, 1);
  assert.equal(fallback.opens, 1);
  assert.deepEqual(events.map((event) => event.provider), ['fallback']);
  assert.deepEqual(fallbackContexts, [
    {
      primary: 'primary',
      fallback: 'fallback',
      errorCode: 'connection_timeout',
    },
  ]);
});

test('commits permanently to a successfully opened primary session', async () => {
  const events: SttSessionEvent[] = [];
  const primarySession = new FakeSession('primary');
  const primary = new FakeProvider('primary', async (options) => {
    void options.onEvent(sessionStarted('primary', options.signal));
    return primarySession;
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
  });

  const session = await provider.open(openOptions(events));
  await tick();

  assert.equal(session, primarySession);
  assert.deepEqual(events.map((event) => event.provider), ['primary']);
  assert.equal(fallback.opens, 0);
});

test('does not deadlock when primary open awaits session_started delivery', async () => {
  const events: SttSessionEvent[] = [];
  const primarySession = new FakeSession('primary');
  const primary = new FakeProvider('primary', async (options) => {
    await options.onEvent(sessionStarted('primary', options.signal));
    return primarySession;
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
  });

  const session = await Promise.race([
    provider.open(openOptions(events)),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('open deadlocked')), 100);
    }),
  ]);

  assert.equal(session, primarySession);
  assert.deepEqual(events.map((event) => event.provider), ['primary']);
  assert.equal(fallback.opens, 0);
});

test('bounds events emitted synchronously while primary is opening', async () => {
  const events: SttSessionEvent[] = [];
  const primary = new FakeProvider('primary', async (options) => {
    await options.onEvent(sessionStarted('primary', options.signal));
    await options.onEvent(sessionStarted('primary', options.signal));
    return new FakeSession('primary');
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
    maxPendingPrimaryEvents: 1,
  });

  await assert.rejects(
    provider.open(openOptions(events)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'backpressure'
  );
  assert.deepEqual(events, []);
  assert.equal(fallback.opens, 0);
});

test('does not fall back after any primary transcript was observed', async () => {
  const events: SttSessionEvent[] = [];
  let primaryDelivery: Promise<void> | undefined;
  const failure = new SttProviderError(
    'socket_error',
    'failed after transcript',
    true
  );
  const primary = new FakeProvider('primary', async (options) => {
    primaryDelivery = Promise.resolve(
      options.onEvent(turnEvent('primary', options.signal))
    );
    throw failure;
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
  });

  await assert.rejects(provider.open(openOptions(events)), (error) => {
    return error === failure;
  });
  await primaryDelivery;

  assert.equal(fallback.opens, 0);
  assert.deepEqual(events, []);
});

test('does not mask configuration and other non-retryable failures', async () => {
  const events: SttSessionEvent[] = [];
  const failure = new SttProviderError(
    'configuration',
    'bad primary key',
    false
  );
  const primary = new FakeProvider('primary', async () => {
    throw failure;
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
  });

  await assert.rejects(provider.open(openOptions(events)), (error) => {
    return error === failure;
  });
  assert.equal(fallback.opens, 0);
});

test('supports an explicit fallback policy without exposing raw errors', async () => {
  const events: SttSessionEvent[] = [];
  const primary = new FakeProvider('primary', async () => {
    throw new SttProviderError(
      'configuration',
      'provider-specific secret',
      false
    );
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
    shouldFallback: (error) => error.code === 'configuration',
  });

  const session = await provider.open(openOptions(events));
  assert.equal(session.provider, 'fallback');
});

test('rejects mismatched audio formats before opening either provider', () => {
  const primary = new FakeProvider('primary', async () => {
    return new FakeSession('primary');
  });
  const fallback = new FakeProvider(
    'fallback',
    async () => new FakeSession('fallback'),
    {
      encoding: 'mulaw',
      sampleRateHz: 16_000,
      channels: 1,
    } as unknown as SttAudioFormat
  );

  assert.throws(
    () =>
      new ColdFallbackStreamingSttProvider({
        primary,
        fallback,
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.equal(primary.opens, 0);
  assert.equal(fallback.opens, 0);
});

test('validates the primary event buffer bound', () => {
  const primary = new FakeProvider('primary', async () => {
    return new FakeSession('primary');
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });

  assert.throws(
    () =>
      new ColdFallbackStreamingSttProvider({
        primary,
        fallback,
        maxPendingPrimaryEvents: 0,
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
});

test('does not open providers when the caller signal is already aborted', async () => {
  const primary = new FakeProvider('primary', async () => {
    return new FakeSession('primary');
  });
  const fallback = new FakeProvider('fallback', async () => {
    return new FakeSession('fallback');
  });
  const provider = new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
  });
  const controller = new AbortController();
  controller.abort('disconnected');

  await assert.rejects(
    provider.open(openOptions([], controller)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'invalid_state'
  );
  assert.equal(primary.opens, 0);
  assert.equal(fallback.opens, 0);
});
