import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket, { type ClientOptions as WebSocketClientOptions } from 'ws';
import {
  AssemblyAiStreamingSttProvider,
  type AssemblyAiStreamingSttProviderOptions,
} from '../../src/voice/providers/assemblyai-stt';
import {
  SttProviderError,
  type StreamingSttSession,
  type SttSessionEvent,
} from '../../src/voice/providers/stt';

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: Array<{
    data: Buffer | string;
    binary: boolean;
  }> = [];
  terminated = false;
  closeCode: number | undefined;
  failSend = false;
  holdSendCallbacks = false;
  readonly pendingSendCallbacks: Array<(error?: Error) => void> = [];

  send(
    data: Buffer | string,
    optionsOrCallback?:
      | { binary?: boolean }
      | ((error?: Error) => void),
    callback?: (error?: Error) => void
  ): void {
    if (this.failSend) throw new Error('simulated send failure');
    const options =
      typeof optionsOrCallback === 'object'
        ? optionsOrCallback
        : undefined;
    const onSent =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : callback;
    if (this.readyState !== WebSocket.OPEN) {
      queueMicrotask(() => onSent?.(new Error('socket is not open')));
      return;
    }
    this.sent.push({
      data: Buffer.isBuffer(data) ? Buffer.from(data) : data,
      binary: options?.binary === true,
    });
    if (!onSent) return;
    if (this.holdSendCallbacks) {
      this.pendingSendCallbacks.push(onSent);
    } else {
      queueMicrotask(() => onSent());
    }
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSING;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  begin(id = 'assembly-session-1'): void {
    this.readyState = WebSocket.OPEN;
    this.serverJson({
      type: 'Begin',
      id,
      expires_at: 1_800_000_000,
    });
  }

  serverJson(message: Record<string, unknown>): void {
    this.emit(
      'message',
      Buffer.from(JSON.stringify(message)),
      false
    );
  }

  malformedJson(): void {
    this.emit('message', Buffer.from('{not-json'), false);
  }

  serverBinary(data = Buffer.from([1, 2])): void {
    this.emit('message', data, true);
  }

  serverClose(code = 1000): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.alloc(0));
  }

  unexpectedResponse(statusCode: number): void {
    this.emit('unexpected-response', {}, { statusCode });
  }
}

function createHarness(
  overrides: Partial<AssemblyAiStreamingSttProviderOptions> = {}
): {
  provider: AssemblyAiStreamingSttProvider;
  socket: FakeWebSocket;
  events: SttSessionEvent[];
  url: () => string | undefined;
  clientOptions: () => WebSocketClientOptions | undefined;
} {
  const socket = new FakeWebSocket();
  const events: SttSessionEvent[] = [];
  let capturedUrl: string | undefined;
  let capturedOptions: WebSocketClientOptions | undefined;
  const provider = new AssemblyAiStreamingSttProvider({
    apiKey: 'assemblyai-secret-key',
    connectTimeoutMs: 100,
    finishTimeoutMs: 100,
    forceEndpointTimeoutMs: 20,
    sendTimeoutMs: 100,
    eventHandlerTimeoutMs: 100,
    webSocketFactory: (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return socket as unknown as WebSocket;
    },
    ...overrides,
  });
  return {
    provider,
    socket,
    events,
    url: () => capturedUrl,
    clientOptions: () => capturedOptions,
  };
}

async function openSession(
  harness: ReturnType<typeof createHarness>,
  controller = new AbortController()
): Promise<StreamingSttSession> {
  const opening = harness.provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: controller.signal,
    onEvent: (event) => {
      harness.events.push(event);
    },
  });
  harness.socket.begin();
  return opening;
}

function turn(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'Turn',
    turn_order: 0,
    turn_is_formatted: false,
    end_of_turn: false,
    transcript: 'привет',
    utterance: '',
    end_of_turn_confidence: 0.2,
    words: [
      {
        start: 120,
        end: 620,
        text: 'привет',
        confidence: 0.97,
        word_is_final: true,
      },
    ],
    language_code: 'ru',
    language_confidence: 0.95,
    ...overrides,
  };
}

function textFrames(socket: FakeWebSocket): string[] {
  return socket.sent
    .filter((frame) => typeof frame.data === 'string')
    .map((frame) => frame.data as string);
}

function binaryFrames(socket: FakeWebSocket): Buffer[] {
  return socket.sent
    .filter((frame) => frame.binary)
    .map((frame) => frame.data as Buffer);
}

function turnEvents(events: SttSessionEvent[]) {
  return events
    .filter((event) => event.type === 'turn')
    .map((event) => event.turn);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 200
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error('condition was not met before timeout');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test('opens v3 with phone audio parameters and plain Authorization header', async () => {
  let now = 1_000;
  const harness = createHarness({
    now: () => now,
  });
  let resolved = false;
  const opening = harness.provider
    .open({
      stream: {
        callId: 'call-1',
        conversationId: 'conversation-1',
      },
      signal: new AbortController().signal,
      onEvent: (event) => {
        harness.events.push(event);
      },
    })
    .then((session) => {
      resolved = true;
      return session;
    });

  await Promise.resolve();
  assert.equal(resolved, false);
  now = 1_025;
  harness.socket.begin('begin-id');
  const session = await opening;
  await tick();

  const url = new URL(harness.url()!);
  assert.equal(url.origin, 'wss://streaming.assemblyai.com');
  assert.equal(url.pathname, '/v3/ws');
  assert.equal(url.searchParams.get('sample_rate'), '8000');
  assert.equal(url.searchParams.get('encoding'), 'pcm_mulaw');
  assert.equal(url.searchParams.get('speech_model'), 'whisper-rt');
  assert.equal(url.searchParams.get('language_detection'), 'true');
  assert.equal(url.searchParams.get('format_turns'), 'true');
  assert.equal(url.searchParams.get('min_turn_silence'), '400');
  assert.equal(url.searchParams.get('max_turn_silence'), '1280');
  assert.equal(url.toString().includes('assemblyai-secret-key'), false);

  assert.deepEqual(harness.clientOptions()?.headers, {
    Authorization: 'assemblyai-secret-key',
  });
  assert.equal(harness.clientOptions()?.perMessageDeflate, false);
  assert.equal(harness.clientOptions()?.maxPayload, 256 * 1024);
  assert.equal(session.state, 'open');
  const started = harness.events.find(
    (event) => event.type === 'session_started'
  );
  assert.equal(started?.type, 'session_started');
  if (started?.type === 'session_started') {
    assert.equal(started.requestId, 'begin-id');
    assert.equal(started.connectMs, 25);
  }
});

test('frames μ-law audio, flushes remainder, and requires Termination', async () => {
  const harness = createHarness();
  const session = await openSession(harness);

  await session.writeAudio(Buffer.alloc(250, 1));
  assert.deepEqual(binaryFrames(harness.socket), []);
  await session.writeAudio(Buffer.alloc(600, 2));
  assert.deepEqual(
    binaryFrames(harness.socket).map((frame) => frame.length),
    [400, 400]
  );

  const finishing = session.finish();
  await waitFor(() =>
    textFrames(harness.socket).includes('{"type":"Terminate"}')
  );
  assert.deepEqual(
    binaryFrames(harness.socket).map((frame) => frame.length),
    [400, 400, 50]
  );
  harness.socket.serverJson({
    type: 'Termination',
    audio_duration_seconds: 0.1,
    session_duration_seconds: 0.2,
  });
  const terminal = await finishing;

  assert.deepEqual(terminal, {
    status: 'completed',
    audioBytes: 850,
    audioFrames: 3,
    turnsCompleted: 0,
    totalMs: terminal.totalMs,
  });
  assert.equal(session.state, 'completed');
  assert.equal(harness.socket.closeCode, 1000);
});

test('commits one formatted final per turn_order and deduplicates snapshots', async () => {
  const harness = createHarness();
  await openSession(harness);

  const partial = turn();
  harness.socket.serverJson(partial);
  harness.socket.serverJson(partial);
  harness.socket.serverJson(
    turn({
      end_of_turn: true,
      end_of_turn_confidence: 0.8,
    })
  );
  const formattedFinal = turn({
    turn_is_formatted: true,
    end_of_turn: true,
    transcript: 'Привет.',
    end_of_turn_confidence: 0.9,
  });
  harness.socket.serverJson(formattedFinal);
  harness.socket.serverJson(formattedFinal);
  await tick();

  const turns = turnEvents(harness.events);
  assert.deepEqual(
    turns.map((snapshot) => snapshot.kind),
    ['start_of_turn', 'update', 'end_of_turn']
  );
  assert.equal(turns[1]?.isFinal, false);
  assert.equal(turns[2]?.isFinal, true);
  assert.equal(turns[2]?.transcript, 'Привет.');
  assert.deepEqual(turns[2]?.languages, ['ru']);
  assert.deepEqual(turns[2]?.words, [
    {
      text: 'привет',
      confidence: 0.97,
      startMs: 120,
      endMs: 620,
    },
  ]);
});

test('maps utterance snapshots to cancellable eager end of turn', async () => {
  const harness = createHarness();
  await openSession(harness);
  harness.socket.serverJson(
    turn({
      utterance: 'привет',
      transcript: 'привет',
    })
  );
  await tick();

  const snapshot = turnEvents(harness.events)[0];
  assert.equal(snapshot?.kind, 'eager_end_of_turn');
  assert.equal(snapshot?.isSpeculative, true);
  assert.equal(snapshot?.isFinal, false);
});

test('ForceEndpoint waits for a formatted final before Terminate', async () => {
  const harness = createHarness({
    forceEndpointTimeoutMs: 50,
    finishTimeoutMs: 200,
  });
  const session = await openSession(harness);
  harness.socket.serverJson(turn());
  await tick();

  const finishing = session.finish();
  await waitFor(() =>
    textFrames(harness.socket).includes('{"type":"ForceEndpoint"}')
  );
  assert.equal(
    textFrames(harness.socket).includes('{"type":"Terminate"}'),
    false
  );

  harness.socket.serverJson(
    turn({
      turn_is_formatted: true,
      end_of_turn: true,
      transcript: 'Привет.',
      end_of_turn_confidence: 0.95,
    })
  );
  await waitFor(() =>
    textFrames(harness.socket).includes('{"type":"Terminate"}')
  );
  harness.socket.serverJson({
    type: 'Termination',
    audio_duration_seconds: 0,
    session_duration_seconds: 0.1,
  });
  const terminal = await finishing;
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.turnsCompleted, 1);
});

test('ForceEndpoint timeout still terminates without inventing a final turn', async () => {
  const harness = createHarness({
    forceEndpointTimeoutMs: 5,
    finishTimeoutMs: 100,
  });
  const session = await openSession(harness);
  harness.socket.serverJson(turn());
  await tick();

  const finishing = session.finish();
  await waitFor(() =>
    textFrames(harness.socket).includes('{"type":"Terminate"}')
  );
  assert.deepEqual(textFrames(harness.socket), [
    '{"type":"ForceEndpoint"}',
    '{"type":"Terminate"}',
  ]);
  harness.socket.serverJson({
    type: 'Termination',
    audio_duration_seconds: 0,
    session_duration_seconds: 0.1,
  });
  const terminal = await finishing;
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.turnsCompleted, 0);
});

test('internal Terminate send failure is contained and fails the stream once', async () => {
  const harness = createHarness({
    forceEndpointTimeoutMs: 50,
    finishTimeoutMs: 200,
  });
  const session = await openSession(harness);
  harness.socket.serverJson(turn());
  await tick();

  const finishing = session.finish();
  await waitFor(() =>
    textFrames(harness.socket).includes('{"type":"ForceEndpoint"}')
  );
  harness.socket.failSend = true;
  harness.socket.serverJson(
    turn({
      turn_is_formatted: true,
      end_of_turn: true,
      transcript: 'Привет.',
      end_of_turn_confidence: 0.95,
    })
  );

  const terminal = await finishing;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'socket_error');
  }
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
});

test('abort terminates the socket and produces a cancelled terminal', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  controller.abort('caller-disconnected');
  const terminal = await session.closed;

  assert.equal(terminal.status, 'cancelled');
  if (terminal.status === 'cancelled') {
    assert.equal(terminal.reason, 'caller-disconnected');
  }
  assert.equal(session.state, 'cancelled');
  assert.equal(harness.socket.terminated, true);
});

test('rejects malformed, binary, and regressing server frames', async (t) => {
  await t.test('malformed JSON', async () => {
    const harness = createHarness();
    const session = await openSession(harness);
    harness.socket.malformedJson();
    const terminal = await session.closed;
    assert.equal(terminal.status, 'failed');
    if (terminal.status === 'failed') {
      assert.equal(terminal.error.code, 'protocol_error');
    }
  });

  await t.test('binary response', async () => {
    const harness = createHarness();
    const session = await openSession(harness);
    harness.socket.serverBinary();
    const terminal = await session.closed;
    assert.equal(terminal.status, 'failed');
    if (terminal.status === 'failed') {
      assert.equal(terminal.error.code, 'protocol_error');
    }
  });

  await t.test('turn order regression', async () => {
    const harness = createHarness();
    const session = await openSession(harness);
    harness.socket.serverJson(turn({ turn_order: 2 }));
    harness.socket.serverJson(turn({ turn_order: 1 }));
    const terminal = await session.closed;
    assert.equal(terminal.status, 'failed');
    if (terminal.status === 'failed') {
      assert.equal(terminal.error.code, 'protocol_error');
    }
  });
});

test('fails closed on audio bounds, socket backpressure, and early close', async (t) => {
  await t.test('audio duration bound', async () => {
    const harness = createHarness({
      maxAudioDurationMs: 1,
    });
    const session = await openSession(harness);
    await assert.rejects(
      session.writeAudio(Buffer.alloc(9)),
      (error: unknown) =>
        error instanceof SttProviderError &&
        error.code === 'audio_limit_exceeded'
    );
    const terminal = await session.closed;
    assert.equal(terminal.status, 'failed');
  });

  await t.test('socket buffer bound', async () => {
    const harness = createHarness({
      maxSocketBufferedBytes: 400,
    });
    const session = await openSession(harness);
    harness.socket.bufferedAmount = 1;
    await assert.rejects(
      session.writeAudio(Buffer.alloc(400)),
      (error: unknown) =>
        error instanceof SttProviderError &&
        error.code === 'backpressure'
    );
    const terminal = await session.closed;
    assert.equal(terminal.status, 'failed');
  });

  await t.test('close without Termination', async () => {
    const harness = createHarness();
    const session = await openSession(harness);
    harness.socket.serverClose(1000);
    const terminal = await session.closed;
    assert.equal(terminal.status, 'failed');
    if (terminal.status === 'failed') {
      assert.equal(terminal.error.code, 'unexpected_close');
    }
  });
});

test('validates credentials, endpoints, and finish timing at construction', () => {
  assert.throws(
    () =>
      new AssemblyAiStreamingSttProvider({
        apiKey: ' ',
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.throws(
    () =>
      new AssemblyAiStreamingSttProvider({
        apiKey: 'valid-key',
        url: 'ws://streaming.assemblyai.com/v3/ws',
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.throws(
    () =>
      new AssemblyAiStreamingSttProvider({
        apiKey: 'valid-key',
        url: 'wss://attacker.example/v3/ws',
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.throws(
    () =>
      new AssemblyAiStreamingSttProvider({
        apiKey: 'valid-key',
        finishTimeoutMs: 100,
        forceEndpointTimeoutMs: 100,
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
});
