import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket, { type ClientOptions as WebSocketClientOptions } from 'ws';
import {
  DeepgramFluxSttProvider,
  type DeepgramFluxSttProviderOptions,
} from '../../src/voice/providers/deepgram-stt';
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
  failSend = false;
  holdSendCallbacks = false;
  readonly pendingSendCallbacks: Array<
    (error?: Error) => void
  > = [];

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

  releaseSend(error?: Error): void {
    const callback = this.pendingSendCallbacks.shift();
    callback?.(error);
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  connected(
    requestId = 'request-1',
    sequenceId = 0
  ): void {
    this.readyState = WebSocket.OPEN;
    this.serverJson({
      type: 'Connected',
      request_id: requestId,
      sequence_id: sequenceId,
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

  socketError(): void {
    this.emit('error', new Error('simulated socket error'));
  }
}

function createHarness(
  overrides: Partial<DeepgramFluxSttProviderOptions> = {}
): {
  provider: DeepgramFluxSttProvider;
  socket: FakeWebSocket;
  events: SttSessionEvent[];
  url: () => string | undefined;
  clientOptions: () => WebSocketClientOptions | undefined;
} {
  const socket = new FakeWebSocket();
  const events: SttSessionEvent[] = [];
  let capturedUrl: string | undefined;
  let capturedOptions: WebSocketClientOptions | undefined;
  const provider = new DeepgramFluxSttProvider({
    apiKey: 'deepgram-secret-key',
    connectTimeoutMs: 100,
    finishTimeoutMs: 100,
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
  harness.socket.connected();
  return opening;
}

function turnInfo(
  sequenceId: number,
  event:
    | 'Update'
    | 'StartOfTurn'
    | 'EndOfTurn'
    | 'EagerEndOfTurn'
    | 'TurnResumed',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'TurnInfo',
    request_id: 'request-1',
    sequence_id: sequenceId,
    event,
    turn_index: 0,
    audio_window_start: 0,
    audio_window_end: 0.8,
    transcript:
      event === 'Update' ? '' : 'Здравствуйте',
    words:
      event === 'Update'
        ? []
        : [
            {
              word: 'Здравствуйте',
              confidence: 0.97,
              start: 0.12,
              end: 0.7,
            },
          ],
    end_of_turn_confidence:
      event === 'EndOfTurn' ? 0.82 : 0.2,
    languages: ['ru'],
    languages_hinted: ['ru'],
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

test('opens Flux with safe defaults and waits for Connected', async () => {
  let now = 1_000;
  const harness = createHarness({
    now: () => now,
  });
  let resolved = false;
  const opening = harness.provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: new AbortController().signal,
    onEvent: (event) => {
      harness.events.push(event);
    },
  });
  void opening.then(() => {
    resolved = true;
  });

  harness.socket.readyState = WebSocket.OPEN;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);

  now = 1_025;
  harness.socket.serverJson({
    type: 'Connected',
    request_id: 'request-42',
    sequence_id: 0,
  });
  const session = await opening;
  assert.equal(session.state, 'open');

  const url = new URL(harness.url()!);
  assert.equal(url.origin, 'wss://api.deepgram.com');
  assert.equal(url.pathname, '/v2/listen');
  assert.equal(url.searchParams.get('model'), 'flux-general-multi');
  assert.equal(url.searchParams.get('encoding'), 'mulaw');
  assert.equal(url.searchParams.get('sample_rate'), '8000');
  assert.deepEqual(url.searchParams.getAll('language_hint'), ['ru']);
  assert.equal(url.searchParams.get('eot_threshold'), '0.7');
  assert.equal(url.searchParams.get('eot_timeout_ms'), '1800');
  assert.equal(url.searchParams.has('eager_eot_threshold'), false);

  const clientOptions = harness.clientOptions();
  assert.equal(
    clientOptions?.headers?.['Authorization'],
    'Token deepgram-secret-key'
  );
  assert.equal(clientOptions?.perMessageDeflate, false);
  assert.equal(clientOptions?.maxPayload, 256 * 1024);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const started = harness.events.find(
    (event) => event.type === 'session_started'
  );
  assert.ok(started && started.type === 'session_started');
  assert.equal(started.requestId, 'request-42');
  assert.equal(started.connectMs, 25);
  assert.deepEqual(started.format, {
    encoding: 'mulaw',
    sampleRateHz: 8000,
    channels: 1,
  });
});

test('keeps credentials out of provider object serialization and supports auto-detect', async () => {
  const harness = createHarness({ languageHints: [] });
  assert.equal(
    JSON.stringify(harness.provider).includes('deepgram-secret-key'),
    false
  );

  const controller = new AbortController();
  const session = await openSession(harness, controller);
  const url = new URL(harness.url()!);
  assert.deepEqual(url.searchParams.getAll('language_hint'), []);
  controller.abort('done');
  await session.closed;
});

test('aggregates μ-law into exact 640-byte frames and flushes remainder before CloseStream', async () => {
  const harness = createHarness();
  const session = await openSession(harness);

  await session.writeAudio(Buffer.alloc(100, 1));
  assert.deepEqual(binaryFrames(harness.socket), []);

  await session.writeAudio(Buffer.alloc(1_200, 2));
  assert.deepEqual(
    binaryFrames(harness.socket).map((frame) => frame.length),
    [640, 640]
  );
  assert.deepEqual(
    binaryFrames(harness.socket)[0],
    Buffer.concat([Buffer.alloc(100, 1), Buffer.alloc(540, 2)])
  );

  const finishing = session.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    binaryFrames(harness.socket).map((frame) => frame.length),
    [640, 640, 20]
  );
  assert.equal(
    harness.socket.sent.at(-1)?.data,
    JSON.stringify({ type: 'CloseStream' })
  );

  harness.socket.serverJson(turnInfo(1, 'EndOfTurn'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.state, 'finishing');
  harness.socket.serverClose(1000);

  const terminal = await finishing;
  assert.deepEqual(terminal, {
    status: 'completed',
    audioBytes: 1_300,
    audioFrames: 3,
    turnsCompleted: 1,
    totalMs: terminal.totalMs,
  });
  assert.equal(session.state, 'completed');
  const eventTypes = harness.events.map((event) => event.type);
  assert.deepEqual(eventTypes, [
    'session_started',
    'turn',
    'terminal',
  ]);
});

test('serializes concurrent audio writes without reordering 80 ms frames', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);

  const first = session.writeAudio(Buffer.alloc(1_280, 1));
  const second = session.writeAudio(Buffer.alloc(640, 2));
  await Promise.all([first, second]);

  const frames = binaryFrames(harness.socket);
  assert.deepEqual(
    frames.map((frame) => frame.length),
    [640, 640, 640]
  );
  assert.deepEqual(
    frames.map((frame) => frame[0]),
    [1, 1, 2]
  );
  controller.abort('done');
  await session.closed;
});

test('cannot report graceful completion when the socket closes before final sends', async () => {
  const harness = createHarness();
  const session = await openSession(harness);
  await session.writeAudio(Buffer.alloc(100, 7));
  harness.socket.readyState = WebSocket.CLOSING;

  const terminal = await session.finish();
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'socket_error');
    assert.equal(terminal.error.retryable, false);
  }
  assert.equal(session.state, 'failed');
  assert.equal(textFrames(harness.socket).length, 0);
});

test('normal server close cannot complete while a pre-finish audio write is in flight', async () => {
  const harness = createHarness({ sendTimeoutMs: 100 });
  harness.socket.holdSendCallbacks = true;
  const session = await openSession(harness);

  const writing = session.writeAudio(Buffer.alloc(640));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.socket.pendingSendCallbacks.length, 1);
  const finishing = session.finish();
  harness.socket.serverClose(1000);

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'unexpected_close');
  }

  harness.socket.releaseSend(new Error('socket closed'));
  await assert.rejects(writing);
  assert.equal((await finishing).status, 'failed');
});

test('normal close waits for the in-flight CloseStream send callback', async () => {
  const harness = createHarness({
    finishTimeoutMs: 100,
    sendTimeoutMs: 100,
  });
  harness.socket.holdSendCallbacks = true;
  const session = await openSession(harness);
  const finishing = session.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    textFrames(harness.socket).at(-1),
    JSON.stringify({ type: 'CloseStream' })
  );

  let resolved = false;
  void finishing.then(() => {
    resolved = true;
  });
  harness.socket.serverClose(1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);

  harness.socket.releaseSend();
  const terminal = await finishing;
  assert.equal(terminal.status, 'completed');
  assert.equal(session.state, 'completed');
});

test('finish timeout bounds a stalled CloseStream send callback', async () => {
  const harness = createHarness({
    finishTimeoutMs: 5,
    sendTimeoutMs: 500,
  });
  harness.socket.holdSendCallbacks = true;
  const session = await openSession(harness);

  const startedAt = Date.now();
  const terminal = await session.finish();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'finish_timeout');
  }
  assert.ok(elapsedMs < 250);
  harness.socket.releaseSend(new Error('released after timeout'));
});

test('bounds concurrent outbound writes before retaining their audio', async () => {
  const harness = createHarness({ maxPendingAudioWrites: 2 });
  const controller = new AbortController();
  const session = await openSession(harness, controller);

  const first = session.writeAudio(Buffer.alloc(1));
  const second = session.writeAudio(Buffer.alloc(1));
  await assert.rejects(
    session.writeAudio(Buffer.alloc(1)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'backpressure' &&
      error.retryable
  );
  await Promise.all([first, second]);
  assert.equal(session.state, 'open');
  controller.abort('done');
  await session.closed;
});

test('does not reorder later concurrent audio across a retryable backpressure gap', async () => {
  const harness = createHarness({ maxSocketBufferedBytes: 640 });
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  await session.writeAudio(Buffer.alloc(100, 1));
  harness.socket.bufferedAmount = 1;

  const rejectedChunk = session.writeAudio(Buffer.alloc(540, 2));
  const laterChunk = session.writeAudio(Buffer.alloc(100, 3));
  const rejected = await Promise.allSettled([
    rejectedChunk,
    laterChunk,
  ]);
  assert.deepEqual(
    rejected.map((result) => result.status),
    ['rejected', 'rejected']
  );
  for (const result of rejected) {
    assert.ok(
      result.status === 'rejected' &&
        result.reason instanceof SttProviderError &&
        result.reason.code === 'backpressure'
    );
  }

  harness.socket.bufferedAmount = 0;
  await session.writeAudio(Buffer.alloc(540, 2));
  await session.writeAudio(Buffer.alloc(100, 3));
  const firstFrame = binaryFrames(harness.socket)[0];
  assert.ok(firstFrame);
  assert.deepEqual(firstFrame.subarray(0, 100), Buffer.alloc(100, 1));
  assert.deepEqual(firstFrame.subarray(100), Buffer.alloc(540, 2));

  controller.abort('done');
  await session.closed;
});

test('cannot complete gracefully while a rejected audio chunk is still missing', async () => {
  const harness = createHarness({ maxSocketBufferedBytes: 640 });
  const session = await openSession(harness);
  await session.writeAudio(Buffer.alloc(100, 1));
  harness.socket.bufferedAmount = 1;
  await assert.rejects(
    session.writeAudio(Buffer.alloc(540, 2)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'backpressure'
  );

  harness.socket.bufferedAmount = 0;
  const terminal = await session.finish();
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'backpressure');
    assert.equal(terminal.error.retryable, false);
  }
  assert.equal(textFrames(harness.socket).length, 0);
});

test('normalizes every Flux turn state without treating eager output as final', async () => {
  const harness = createHarness({
    eagerEotThreshold: 0.55,
    languageHints: ['ru', 'en'],
  });
  const session = await openSession(harness);
  const connectionUrl = new URL(harness.url()!);
  assert.equal(
    connectionUrl.searchParams.get('eager_eot_threshold'),
    '0.55'
  );
  assert.deepEqual(
    connectionUrl.searchParams.getAll('language_hint'),
    ['ru', 'en']
  );

  const providerEvents = [
    'Update',
    'StartOfTurn',
    'EagerEndOfTurn',
    'TurnResumed',
    'EndOfTurn',
  ] as const;
  providerEvents.forEach((event, index) => {
    harness.socket.serverJson(turnInfo(index + 1, event));
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const turns = harness.events
    .filter((event) => event.type === 'turn')
    .map((event) => event.turn);
  assert.deepEqual(
    turns.map((turn) => turn.kind),
    [
      'update',
      'start_of_turn',
      'eager_end_of_turn',
      'turn_resumed',
      'end_of_turn',
    ]
  );
  assert.deepEqual(
    turns.map((turn) => turn.isFinal),
    [false, false, false, false, true]
  );
  assert.deepEqual(
    turns.map((turn) => turn.isSpeculative),
    [false, false, true, false, false]
  );
  assert.deepEqual(turns.at(-1)?.words, [
    {
      text: 'Здравствуйте',
      confidence: 0.97,
      startMs: 120,
      endMs: 700,
    },
  ]);
  assert.equal(turns.at(-1)?.audioWindowEndMs, 800);
  assert.deepEqual(turns.at(-1)?.languages, ['ru']);
  assert.deepEqual(turns.at(-1)?.languagesHinted, ['ru']);

  const finishing = session.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.socket.serverClose();
  const terminal = await finishing;
  assert.equal(terminal.status, 'completed');
  if (terminal.status === 'completed') {
    assert.equal(terminal.turnsCompleted, 1);
  }
});

test('abort terminates immediately, sends no CloseStream and rejects stale writes', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  await session.writeAudio(Buffer.alloc(640));

  controller.abort('barge-in');
  const terminal = await session.closed;
  assert.equal(terminal.status, 'cancelled');
  if (terminal.status === 'cancelled') {
    assert.equal(terminal.reason, 'barge-in');
  }
  assert.equal(session.state, 'cancelled');
  assert.equal(harness.socket.terminated, true);
  assert.equal(textFrames(harness.socket).length, 0);
  await assert.rejects(
    session.writeAudio(Buffer.alloc(640)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'invalid_state'
  );

  harness.socket.serverJson(turnInfo(1, 'EndOfTurn'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    harness.events.filter((event) => event.type === 'turn').length,
    0
  );
});

test('abort while opening rejects once and wins the connection-timeout race', async () => {
  const harness = createHarness({ connectTimeoutMs: 5 });
  const controller = new AbortController();
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

  controller.abort('caller-left');
  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'invalid_state'
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.equal(harness.socket.terminated, true);
  const terminals = harness.events.filter(
    (event) => event.type === 'terminal'
  );
  assert.equal(terminals.length, 1);
  assert.equal(
    terminals[0]?.type === 'terminal'
      ? terminals[0].terminal.status
      : undefined,
    'cancelled'
  );
});

test('serializes turn delivery and waits for final callbacks before completing', async () => {
  const socket = new FakeWebSocket();
  const eventOrder: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider = new DeepgramFluxSttProvider({
    apiKey: 'deepgram-secret-key',
    eventHandlerTimeoutMs: 100,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type !== 'turn') return;
      eventOrder.push(`start-${event.turn.serverSequence}`);
      if (event.turn.serverSequence === 1) await firstGate;
      eventOrder.push(`end-${event.turn.serverSequence}`);
    },
  });
  socket.connected();
  const session = await opening;
  const finishing = session.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.serverJson(turnInfo(1, 'StartOfTurn'));
  socket.serverJson(turnInfo(2, 'EndOfTurn'));
  socket.serverClose();

  let closedResolved = false;
  void finishing.then(() => {
    closedResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(eventOrder, ['start-1']);
  assert.equal(closedResolved, false);

  releaseFirst();
  await finishing;
  assert.deepEqual(eventOrder, [
    'start-1',
    'end-1',
    'start-2',
    'end-2',
  ]);
});

test('accepts an empty live multilingual StartOfTurn placeholder', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);

  harness.socket.serverJson(
    turnInfo(1, 'StartOfTurn', {
      transcript: '',
      words: [],
      languages: [],
    })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const turnEvent = harness.events.find((event) => event.type === 'turn');
  assert.equal(turnEvent?.type, 'turn');
  if (turnEvent?.type === 'turn') {
    assert.equal(turnEvent.turn.kind, 'start_of_turn');
    assert.equal(turnEvent.turn.transcript, '');
    assert.deepEqual(turnEvent.turn.words, []);
  }
  assert.equal(session.state, 'open');

  controller.abort('done');
  await session.closed;
});

test('cancellation drops turn events queued behind an active callback', async () => {
  const socket = new FakeWebSocket();
  const controller = new AbortController();
  const deliveredSequences: number[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider = new DeepgramFluxSttProvider({
    apiKey: 'deepgram-secret-key',
    eventHandlerTimeoutMs: 100,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: controller.signal,
    onEvent: async (event) => {
      if (event.type !== 'turn') return;
      deliveredSequences.push(event.turn.serverSequence);
      if (event.turn.serverSequence === 1) await firstGate;
    },
  });
  socket.connected();
  const session = await opening;
  socket.serverJson(turnInfo(1, 'StartOfTurn'));
  socket.serverJson(turnInfo(2, 'Update'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  controller.abort('superseded');
  releaseFirst();
  const terminal = await session.closed;
  assert.equal(terminal.status, 'cancelled');
  assert.deepEqual(deliveredSequences, [1]);
});

test('event-handler timeout aborts delivery, suppresses queued turns and fails once', async () => {
  const socket = new FakeWebSocket();
  const deliveredSequences: number[] = [];
  const handlerErrors: string[] = [];
  let eventSignal: AbortSignal | undefined;
  const provider = new DeepgramFluxSttProvider({
    apiKey: 'deepgram-secret-key',
    eventHandlerTimeoutMs: 5,
    onEventHandlerError: (_error, context) => {
      handlerErrors.push(context.eventType);
    },
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type !== 'turn') return;
      deliveredSequences.push(event.turn.serverSequence);
      eventSignal = event.signal;
      await new Promise<void>((resolve) => {
        event.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    },
  });
  socket.connected();
  const session = await opening;
  socket.serverJson(turnInfo(1, 'StartOfTurn'));
  socket.serverJson(turnInfo(2, 'Update'));

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'backpressure');
    assert.equal(terminal.error.retryable, false);
  }
  assert.equal(session.state, 'failed');
  assert.deepEqual(deliveredSequences, [1]);
  assert.equal(eventSignal?.aborted, true);
  assert.equal(eventSignal?.reason, 'event-handler-timeout');
  assert.deepEqual(handlerErrors, ['turn']);
  assert.equal(
    handlerErrors.includes('terminal'),
    false
  );
});

test('bounds the pending TurnInfo queue even when each callback is below its timeout', async () => {
  const socket = new FakeWebSocket();
  const deliveredSequences: number[] = [];
  const provider = new DeepgramFluxSttProvider({
    apiKey: 'deepgram-secret-key',
    eventHandlerTimeoutMs: 100,
    maxPendingTurnEvents: 2,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type !== 'turn') return;
      deliveredSequences.push(event.turn.serverSequence);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        event.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    },
  });
  socket.connected();
  const session = await opening;
  socket.serverJson(turnInfo(1, 'StartOfTurn'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.serverJson(turnInfo(2, 'Update'));
  socket.serverJson(turnInfo(3, 'Update'));

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'backpressure');
    assert.equal(terminal.error.retryable, false);
  }
  assert.deepEqual(deliveredSequences, [1]);
});

test('malformed, binary, duplicate and out-of-order protocol messages fail safely', async () => {
  const malformedHarness = createHarness();
  const malformedSession = await openSession(malformedHarness);
  malformedHarness.socket.malformedJson();
  const malformedTerminal = await malformedSession.closed;
  assert.equal(malformedTerminal.status, 'failed');
  if (malformedTerminal.status === 'failed') {
    assert.equal(malformedTerminal.error.code, 'protocol_error');
  }

  const binaryHarness = createHarness();
  const binarySession = await openSession(binaryHarness);
  binaryHarness.socket.serverBinary();
  const binaryTerminal = await binarySession.closed;
  assert.equal(binaryTerminal.status, 'failed');
  if (binaryTerminal.status === 'failed') {
    assert.equal(binaryTerminal.error.code, 'protocol_error');
  }

  const sequenceHarness = createHarness();
  const sequenceSession = await openSession(sequenceHarness);
  sequenceHarness.socket.serverJson(turnInfo(1, 'StartOfTurn'));
  sequenceHarness.socket.serverJson(turnInfo(1, 'Update'));
  const sequenceTerminal = await sequenceSession.closed;
  assert.equal(sequenceTerminal.status, 'failed');
  if (sequenceTerminal.status === 'failed') {
    assert.equal(sequenceTerminal.error.code, 'protocol_error');
  }

  const duplicateHarness = createHarness();
  const duplicateSession = await openSession(duplicateHarness);
  duplicateHarness.socket.serverJson({
    type: 'Connected',
    request_id: 'request-2',
    sequence_id: 1,
  });
  const duplicateTerminal = await duplicateSession.closed;
  assert.equal(duplicateTerminal.status, 'failed');
  if (duplicateTerminal.status === 'failed') {
    assert.equal(duplicateTerminal.error.code, 'protocol_error');
  }
});

test('provider errors are classified, terminal exactly once and credential-safe', async () => {
  const harness = createHarness();
  const session = await openSession(harness);
  harness.socket.serverJson({
    type: 'Error',
    sequence_id: 1,
    code: 'INTERNAL_SERVER_ERROR',
    description: 'deepgram-secret-key must never be copied',
  });

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'provider_error');
    assert.equal(terminal.error.retryable, true);
    assert.equal(
      terminal.error.message.includes('deepgram-secret-key'),
      false
    );
    assert.equal(
      terminal.error.stack?.includes('deepgram-secret-key') ?? false,
      false
    );
  }
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
});

test('classifies handshake failures without exposing credentials', async () => {
  const harness = createHarness();
  const opening = harness.provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: new AbortController().signal,
    onEvent: (event) => {
      harness.events.push(event);
    },
  });
  harness.socket.unexpectedResponse(401);

  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration' &&
      !error.retryable &&
      !error.message.includes('deepgram-secret-key') &&
      !(error.stack?.includes('deepgram-secret-key') ?? false)
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
});

test('rejects insecure or untrusted endpoints unless custom WSS is explicit', () => {
  assert.throws(
    () =>
      new DeepgramFluxSttProvider({
        apiKey: 'deepgram-secret-key',
        url: 'ws://api.deepgram.com/v2/listen',
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.throws(
    () =>
      new DeepgramFluxSttProvider({
        apiKey: 'deepgram-secret-key',
        url: 'wss://example.com/v2/listen',
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.doesNotThrow(
    () =>
      new DeepgramFluxSttProvider({
        apiKey: 'deepgram-secret-key',
        url: 'wss://trusted.internal/stt',
        allowCustomEndpoint: true,
      })
  );
  assert.throws(
    () =>
      new DeepgramFluxSttProvider({
        apiKey: 'deepgram-secret-key',
        languageHints: ['kk'],
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
  assert.throws(
    () =>
      new DeepgramFluxSttProvider({
        apiKey: 'deepgram-secret-key',
        eotThreshold: 0.6,
        eagerEotThreshold: 0.7,
      }),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'configuration'
  );
});

test('enforces backpressure before accepting input and preserves stream state', async () => {
  const harness = createHarness({ maxSocketBufferedBytes: 640 });
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  harness.socket.bufferedAmount = 1;

  await assert.rejects(
    session.writeAudio(Buffer.alloc(640)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'backpressure' &&
      error.retryable
  );
  assert.equal(session.state, 'open');
  assert.equal(binaryFrames(harness.socket).length, 0);

  harness.socket.bufferedAmount = 0;
  await session.writeAudio(Buffer.alloc(640));
  assert.equal(binaryFrames(harness.socket).length, 1);
  controller.abort('done');
  await session.closed;
});

test('connection, graceful-finish and unexpected-close timeouts are terminal', async () => {
  const connectionHarness = createHarness({ connectTimeoutMs: 5 });
  const opening = connectionHarness.provider.open({
    stream: {
      callId: 'call-1',
      conversationId: 'conversation-1',
    },
    signal: new AbortController().signal,
    onEvent: (event) => {
      connectionHarness.events.push(event);
    },
  });
  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'connection_timeout'
  );

  const finishHarness = createHarness({ finishTimeoutMs: 5 });
  const finishSession = await openSession(finishHarness);
  const finishTerminal = await finishSession.finish();
  assert.equal(finishTerminal.status, 'failed');
  if (finishTerminal.status === 'failed') {
    assert.equal(finishTerminal.error.code, 'finish_timeout');
  }

  const closeHarness = createHarness();
  const closeSession = await openSession(closeHarness);
  closeHarness.socket.serverClose(1011);
  const closeTerminal = await closeSession.closed;
  assert.equal(closeTerminal.status, 'failed');
  if (closeTerminal.status === 'failed') {
    assert.equal(closeTerminal.error.code, 'unexpected_close');
  }
});

test('audio limits and socket send failures cannot leave a writable session', async () => {
  const limitHarness = createHarness({ maxAudioDurationMs: 80 });
  const limitSession = await openSession(limitHarness);
  await assert.rejects(
    limitSession.writeAudio(Buffer.alloc(641)),
    (error: unknown) =>
      error instanceof SttProviderError &&
      error.code === 'audio_limit_exceeded'
  );
  assert.equal(limitSession.state, 'failed');
  assert.equal((await limitSession.closed).status, 'failed');

  const sendHarness = createHarness();
  const sendSession = await openSession(sendHarness);
  sendHarness.socket.failSend = true;
  await assert.rejects(
    sendSession.writeAudio(Buffer.alloc(640)),
    (error: unknown) => {
      assert.ok(error instanceof SttProviderError);
      assert.equal(error.code, 'socket_error');
      assert.equal(error.retryable, false);
      return true;
    }
  );
  assert.equal(sendSession.state, 'failed');
  const sendTerminal = await sendSession.closed;
  assert.equal(sendTerminal.status, 'failed');
  if (sendTerminal.status === 'failed') {
    assert.equal(sendTerminal.error.retryable, false);
  }
});

test('unknown forward-compatible messages are ignored, malformed TurnInfo is not', async () => {
  const ignoredHarness = createHarness();
  const controller = new AbortController();
  const ignoredSession = await openSession(ignoredHarness, controller);
  ignoredHarness.socket.serverJson({
    type: 'FutureMetadata',
    sequence_id: 1,
  });
  assert.equal(ignoredSession.state, 'open');
  controller.abort('done');
  await ignoredSession.closed;

  const invalidHarness = createHarness();
  const invalidSession = await openSession(invalidHarness);
  invalidHarness.socket.serverJson(
    turnInfo(1, 'EndOfTurn', {
      end_of_turn_confidence: 2,
    })
  );
  const invalidTerminal = await invalidSession.closed;
  assert.equal(invalidTerminal.status, 'failed');
  if (invalidTerminal.status === 'failed') {
    assert.equal(invalidTerminal.error.code, 'protocol_error');
  }
});

test('accepts valid Flux words without optional timestamps', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  harness.socket.serverJson(
    turnInfo(1, 'EndOfTurn', {
      words: [
        {
          word: 'Здравствуйте',
          confidence: 0.97,
        },
      ],
    })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const turnEvent = harness.events.find(
    (event) => event.type === 'turn'
  );
  assert.ok(turnEvent && turnEvent.type === 'turn');
  assert.deepEqual(turnEvent.turn.words, [
    {
      text: 'Здравствуйте',
      confidence: 0.97,
    },
  ]);
  controller.abort('done');
  await session.closed;
});

test('clamps negligible negative Flux timestamp drift to zero', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  harness.socket.serverJson(
    turnInfo(1, 'Update', {
      transcript: 'Здравствуйте',
      words: [
        {
          word: 'Здравствуйте',
          confidence: 0.97,
          start: -2.1457672083613488e-8,
          end: 0.7,
        },
      ],
    })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const turnEvent = harness.events.find((event) => event.type === 'turn');
  assert.equal(turnEvent?.type, 'turn');
  if (turnEvent?.type === 'turn') {
    assert.equal(turnEvent.turn.words[0]?.startMs, 0);
    assert.equal(turnEvent.turn.words[0]?.endMs, 700);
  }
  assert.equal(session.state, 'open');

  controller.abort('done');
  await session.closed;
});
