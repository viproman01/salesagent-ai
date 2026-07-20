import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { decode, encode } from '@msgpack/msgpack';
import WebSocket, { type ClientOptions as WebSocketClientOptions } from 'ws';
import {
  FishTtsProvider,
  type FishTtsProviderOptions,
} from '../../src/voice/providers/fish-tts';
import {
  TtsProviderError,
  type CommittedSpeechSegment,
  type StreamingTtsSession,
  type TtsSessionEvent,
  type TurnRef,
} from '../../src/voice/providers/tts';

const TURN: TurnRef = Object.freeze({
  callId: 'call-1',
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  generation: 1,
});

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminated = false;
  failSend = false;

  send(data: unknown): void {
    if (this.failSend) throw new Error('simulated send failure');
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error('socket is not open');
    }
    this.sent.push(Buffer.from(data as Uint8Array));
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  serverEvent(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(encode(event)));
  }

  malformedFrame(): void {
    this.emit('message', Buffer.from([0xc1]));
  }

  unexpectedResponse(statusCode: number): void {
    this.emit('unexpected-response', {}, { statusCode });
  }

  socketError(): void {
    this.emit('error', new Error('simulated socket error'));
  }
}

function createHarness(
  overrides: Partial<FishTtsProviderOptions> = {}
): {
  provider: FishTtsProvider;
  socket: FakeWebSocket;
  events: TtsSessionEvent[];
  headers: () => WebSocketClientOptions['headers'];
  clientOptions: () => WebSocketClientOptions | undefined;
} {
  const socket = new FakeWebSocket();
  const events: TtsSessionEvent[] = [];
  let capturedOptions: WebSocketClientOptions | undefined;
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    connectTimeoutMs: 100,
    firstAudioTimeoutMs: 100,
    finishTimeoutMs: 100,
    webSocketFactory: (_url, options) => {
      capturedOptions = options;
      return socket as unknown as WebSocket;
    },
    ...overrides,
  });

  return {
    provider,
    socket,
    events,
    headers: () => capturedOptions?.headers,
    clientOptions: () => capturedOptions,
  };
}

async function openSession(
  harness: ReturnType<typeof createHarness>,
  controller = new AbortController()
): Promise<StreamingTtsSession> {
  const opening = harness.provider.open({
    turn: TURN,
    signal: controller.signal,
    onEvent: (event) => {
      harness.events.push(event);
    },
  });
  harness.socket.open();
  return opening;
}

function segment(
  sequence: number,
  text = 'Здравствуйте. ',
  turn: TurnRef = TURN
): CommittedSpeechSegment {
  return { kind: 'committed', turn, sequence, text };
}

function decodedFrame(socket: FakeWebSocket, index: number): Record<string, unknown> {
  return decode(socket.sent[index]!) as Record<string, unknown>;
}

test('opens Fish with auth/model headers and sends MessagePack protocol in order', async () => {
  let now = 1_000;
  const harness = createHarness({
    model: 's2-pro',
    sampleRateHz: 8000,
    chunkLength: 100,
    latency: 'balanced',
    now: () => now,
  });

  const session = await openSession(harness);
  assert.equal(harness.headers()?.['Authorization'], 'Bearer fish-secret-key');
  assert.equal(harness.headers()?.['model'], 's2-pro');
  assert.equal(harness.clientOptions()?.perMessageDeflate, false);
  assert.equal(harness.clientOptions()?.maxPayload, 512 * 1024);

  const start = decodedFrame(harness.socket, 0);
  assert.equal(start['event'], 'start');
  assert.deepEqual(start['request'], {
    text: '',
    format: 'pcm',
    sample_rate: 8000,
    reference_id: 'voice-reference',
    latency: 'balanced',
    chunk_length: 100,
    min_chunk_length: 50,
    normalize: true,
    condition_on_previous_chunks: true,
  });

  await session.write(segment(0));
  await session.flush();
  assert.deepEqual(decodedFrame(harness.socket, 1), {
    event: 'text',
    text: 'Здравствуйте. ',
  });
  assert.deepEqual(decodedFrame(harness.socket, 2), { event: 'flush' });

  now = 1_075;
  harness.socket.serverEvent({
    event: 'audio',
    audio: new Uint8Array([1, 2, 3, 4]),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const audioEvent = harness.events.find((event) => event.type === 'audio');
  assert.ok(audioEvent && audioEvent.type === 'audio');
  assert.deepEqual(audioEvent.data, Buffer.from([1, 2, 3, 4]));
  assert.equal(audioEvent.firstAudioMs, 75);
  assert.deepEqual(audioEvent.format, {
    encoding: 'pcm_s16',
    sampleRateHz: 8000,
    channels: 1,
  });

  const finishing = session.finish();
  assert.deepEqual(decodedFrame(harness.socket, 3), { event: 'stop' });
  harness.socket.serverEvent({ event: 'finish', reason: 'stop' });
  const terminal = await finishing;
  assert.equal(terminal.status, 'completed');
  assert.equal(session.state, 'completed');
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
});

test('rejects speculative, duplicate and cross-generation segments', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);

  await assert.rejects(
    session.write({ ...segment(0), kind: 'speculative' as 'committed' }),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'invalid_segment'
  );
  await assert.rejects(
    session.write(segment(1)),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'invalid_segment'
  );
  await assert.rejects(
    session.write(segment(0, 'Текст', { ...TURN, generation: 2 })),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'invalid_segment'
  );

  await session.write(segment(0));
  await assert.rejects(
    session.write(segment(0)),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'invalid_segment'
  );
  controller.abort('test complete');
  assert.equal((await session.closed).status, 'cancelled');
});

test('abort closes immediately, sends no stop and drops late audio', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  await session.write(segment(0));

  controller.abort('barge-in');
  const terminal = await session.closed;
  assert.deepEqual(terminal, {
    status: 'cancelled',
    reason: 'barge-in',
    audioBytes: 0,
    audioChunks: 0,
    totalMs: terminal.totalMs,
  });
  assert.equal(session.state, 'cancelled');
  assert.equal(harness.socket.closeCalls.length, 0);
  assert.equal(harness.socket.terminated, true);
  assert.equal(
    harness.socket.sent.some((frame) => decoded(frame)['event'] === 'stop'),
    false
  );

  harness.socket.serverEvent({
    event: 'audio',
    audio: new Uint8Array([9, 9]),
  });
  assert.equal(
    harness.events.filter((event) => event.type === 'audio').length,
    0
  );
  await assert.rejects(
    session.write(segment(1)),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'invalid_state'
  );
});

test('provider error is terminal exactly once and does not expose the API key', async () => {
  const harness = createHarness();
  const session = await openSession(harness);
  await session.write(segment(0));
  await session.flush();

  const finishing = session.finish();
  harness.socket.serverEvent({ event: 'finish', reason: 'error' });
  const terminal = await finishing;
  assert.equal(terminal.status, 'failed');
  assert.equal(session.state, 'failed');
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'provider_error');
    assert.equal(terminal.error.message.includes('fish-secret-key'), false);
    assert.equal(terminal.error.stack?.includes('fish-secret-key') ?? false, false);
    assert.equal(String(terminal.error.cause).includes('fish-secret-key'), false);
  }
});

test('finish resolves to a failed terminal when the stop frame cannot be sent', async () => {
  const harness = createHarness();
  const session = await openSession(harness);
  harness.socket.failSend = true;

  const terminal = await session.finish();
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'socket_error');
  }
  assert.equal(session.state, 'failed');
});

test('malformed frames fail safely while unknown events are ignored', async () => {
  const ignoredHarness = createHarness();
  const ignoredController = new AbortController();
  const ignoredSession = await openSession(ignoredHarness, ignoredController);
  ignoredHarness.socket.serverEvent({ event: 'metadata', value: 1 });
  assert.equal(ignoredSession.state, 'open');
  ignoredController.abort('done');
  await ignoredSession.closed;

  const malformedHarness = createHarness();
  const malformedSession = await openSession(malformedHarness);
  malformedHarness.socket.malformedFrame();
  const terminal = await malformedSession.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'protocol_error');
    assert.equal(terminal.error.retryable, false);
  }
});

test('rejects early and silent finish events instead of reporting success', async () => {
  const earlyHarness = createHarness();
  const earlySession = await openSession(earlyHarness);
  earlyHarness.socket.serverEvent({ event: 'finish', reason: 'stop' });
  const earlyTerminal = await earlySession.closed;
  assert.equal(earlyTerminal.status, 'failed');
  if (earlyTerminal.status === 'failed') {
    assert.equal(earlyTerminal.error.code, 'protocol_error');
  }

  const silentHarness = createHarness();
  const silentSession = await openSession(silentHarness);
  await silentSession.write(segment(0));
  const finishing = silentSession.finish();
  silentHarness.socket.serverEvent({ event: 'finish', reason: 'stop' });
  const silentTerminal = await finishing;
  assert.equal(silentTerminal.status, 'failed');
  if (silentTerminal.status === 'failed') {
    assert.equal(silentTerminal.error.code, 'first_audio_timeout');
  }
});

test('accepts provider error as terminal while the text stream is still open', async () => {
  const harness = createHarness();
  const session = await openSession(harness);
  await session.write(segment(0));
  harness.socket.serverEvent({ event: 'finish', reason: 'error' });

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'provider_error');
    assert.equal(terminal.error.retryable, true);
  }
});

test('serializes async event handlers and waits for pending audio before closed', async () => {
  const socket = new FakeWebSocket();
  const eventOrder: string[] = [];
  let releaseFirstAudio!: () => void;
  const firstAudioGate = new Promise<void>((resolve) => {
    releaseFirstAudio = resolve;
  });
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    connectTimeoutMs: 100,
    firstAudioTimeoutMs: 100,
    finishTimeoutMs: 100,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type === 'audio') {
        eventOrder.push(`start-${event.sequence}`);
        if (event.sequence === 0) await firstAudioGate;
        eventOrder.push(`end-${event.sequence}`);
      }
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  const finishing = session.finish();
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([3, 4]) });
  socket.serverEvent({ event: 'finish', reason: 'stop' });

  let closedResolved = false;
  void finishing.then(() => {
    closedResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(eventOrder, ['start-0']);
  assert.equal(closedResolved, false);

  releaseFirstAudio();
  await finishing;
  assert.deepEqual(eventOrder, ['start-0', 'end-0', 'start-1', 'end-1']);
});

test('drops queued audio events after cancellation', async () => {
  const socket = new FakeWebSocket();
  const controller = new AbortController();
  const deliveredAudio: number[] = [];
  let releaseFirstAudio!: () => void;
  const firstAudioGate = new Promise<void>((resolve) => {
    releaseFirstAudio = resolve;
  });
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    eventHandlerTimeoutMs: 100,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: controller.signal,
    onEvent: async (event) => {
      if (event.type !== 'audio') return;
      deliveredAudio.push(event.sequence);
      if (event.sequence === 0) await firstAudioGate;
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([3, 4]) });
  await new Promise<void>((resolve) => setImmediate(resolve));

  controller.abort('barge-in');
  releaseFirstAudio();
  const terminal = await session.closed;
  assert.equal(terminal.status, 'cancelled');
  assert.deepEqual(deliveredAudio, [0]);
});

test('event-handler timeout prevents cancellation teardown from hanging', async () => {
  const socket = new FakeWebSocket();
  const controller = new AbortController();
  const handlerErrors: Array<{ eventType: string }> = [];
  const never = new Promise<void>(() => undefined);
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    eventHandlerTimeoutMs: 5,
    onEventHandlerError: (_error, context) => {
      handlerErrors.push({ eventType: context.eventType });
    },
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: controller.signal,
    onEvent: async (event) => {
      if (event.type === 'audio') await never;
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });
  await new Promise<void>((resolve) => setImmediate(resolve));

  controller.abort('barge-in');
  const terminal = await session.closed;
  assert.equal(terminal.status, 'cancelled');
  assert.deepEqual(handlerErrors, [{ eventType: 'audio' }]);
});

test('event-handler timeout aborts delivery and fails before queued audio is emitted', async () => {
  const socket = new FakeWebSocket();
  const deliveredAudio: number[] = [];
  const handlerErrors: Array<{ eventType: string }> = [];
  let deliverySignal: AbortSignal | undefined;
  let abortObserved = false;
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    eventHandlerTimeoutMs: 5,
    onEventHandlerError: (_error, context) => {
      handlerErrors.push({ eventType: context.eventType });
    },
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type !== 'audio') return;
      deliveredAudio.push(event.sequence);
      deliverySignal = event.signal;
      await new Promise<void>((resolve) => {
        event.signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            resolve();
          },
          { once: true }
        );
      });
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([3, 4]) });

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'backpressure');
    assert.equal(terminal.error.retryable, false);
  }
  assert.equal(session.state, 'failed');
  assert.deepEqual(deliveredAudio, [0]);
  assert.equal(abortObserved, true);
  assert.equal(deliverySignal?.aborted, true);
  assert.equal(deliverySignal?.reason, 'event-handler-timeout');
  assert.deepEqual(handlerErrors, [{ eventType: 'audio' }]);
});

test('provider finish cannot report completed before audio delivery succeeds', async () => {
  const socket = new FakeWebSocket();
  const never = new Promise<void>(() => undefined);
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    eventHandlerTimeoutMs: 5,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type === 'audio') await never;
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  const finishing = session.finish();
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });
  socket.serverEvent({ event: 'finish', reason: 'stop' });

  const terminal = await finishing;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'backpressure');
  }
  assert.equal(session.state, 'failed');
});

test('rejected audio delivery fails the session instead of losing audio silently', async () => {
  const socket = new FakeWebSocket();
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type === 'audio') {
        throw new Error('simulated transport failure');
      }
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'backpressure');
    assert.equal(terminal.error.retryable, false);
  }
  assert.equal(session.state, 'failed');
});

test('closed waits for the async terminal event handler', async () => {
  const socket = new FakeWebSocket();
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  const provider = new FishTtsProvider({
    apiKey: 'fish-secret-key',
    referenceId: 'voice-reference',
    eventHandlerTimeoutMs: 100,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const opening = provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: async (event) => {
      if (event.type === 'terminal') await terminalGate;
    },
  });
  socket.open();
  const session = await opening;
  await session.write(segment(0));
  const finishing = session.finish();
  socket.serverEvent({ event: 'audio', audio: new Uint8Array([1, 2]) });
  socket.serverEvent({ event: 'finish', reason: 'stop' });

  let resolved = false;
  void finishing.then(() => {
    resolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  releaseTerminal();
  await finishing;
  assert.equal(resolved, true);
});

test('commits failure atomically when an error handler aborts re-entrantly', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const opening = harness.provider.open({
    turn: TURN,
    signal: controller.signal,
    onEvent: (event) => {
      harness.events.push(event);
      if (event.type === 'error') controller.abort('error callback');
    },
  });
  harness.socket.open();
  const session = await opening;
  harness.socket.malformedFrame();
  const terminal = await session.closed;

  assert.equal(terminal.status, 'failed');
  assert.equal(session.state, 'failed');
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
});

test('classifies handshake status without exposing credentials', async () => {
  const harness = createHarness();
  const opening = harness.provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: (event) => {
      harness.events.push(event);
    },
  });
  harness.socket.unexpectedResponse(401);

  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof TtsProviderError &&
      error.code === 'configuration' &&
      !error.retryable &&
      !error.message.includes('fish-secret-key') &&
      !(error.stack?.includes('fish-secret-key') ?? false)
  );
});

test('rejects insecure and untrusted Fish endpoints by default', () => {
  assert.throws(
    () =>
      new FishTtsProvider({
        apiKey: 'fish-secret-key',
        url: 'ws://api.fish.audio/v1/tts/live',
      }),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'configuration'
  );
  assert.throws(
    () =>
      new FishTtsProvider({
        apiKey: 'fish-secret-key',
        url: 'wss://example.com/v1/tts/live',
      }),
    (error: unknown) =>
      error instanceof TtsProviderError && error.code === 'configuration'
  );
  assert.doesNotThrow(
    () =>
      new FishTtsProvider({
        apiKey: 'fish-secret-key',
        url: 'wss://trusted.internal/tts',
        allowCustomEndpoint: true,
      })
  );
});

test('enforces outbound WebSocket backpressure without killing the session', async () => {
  const harness = createHarness({ maxSocketBufferedBytes: 10 });
  const controller = new AbortController();
  const session = await openSession(harness, controller);
  harness.socket.bufferedAmount = 11;

  await assert.rejects(
    session.write(segment(0)),
    (error: unknown) =>
      error instanceof TtsProviderError &&
      error.code === 'backpressure' &&
      error.retryable
  );
  assert.equal(session.state, 'open');
  controller.abort('done');
  await session.closed;
});

test('connection timeout rejects open and emits one failed terminal', async () => {
  const harness = createHarness({ connectTimeoutMs: 5 });
  const opening = harness.provider.open({
    turn: TURN,
    signal: new AbortController().signal,
    onEvent: (event) => {
      harness.events.push(event);
    },
  });

  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof TtsProviderError &&
      error.code === 'connection_timeout' &&
      error.retryable
  );
  assert.equal(
    harness.events.filter((event) => event.type === 'terminal').length,
    1
  );
});

test('starts the first-audio timeout only after an explicit flush', async () => {
  const harness = createHarness({ firstAudioTimeoutMs: 5 });
  const session = await openSession(harness);
  await session.write(segment(0));

  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(session.state, 'open');
  await session.flush();
  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.error.code, 'first_audio_timeout');
    assert.equal(terminal.error.retryable, true);
  }
});

test('never marks a transport failure retryable after audio has started', async () => {
  const harness = createHarness();
  const session = await openSession(harness);
  await session.write(segment(0));
  harness.socket.serverEvent({
    event: 'audio',
    audio: new Uint8Array([1, 2]),
  });
  harness.socket.socketError();

  const terminal = await session.closed;
  assert.equal(terminal.status, 'failed');
  if (terminal.status === 'failed') {
    assert.equal(terminal.audioStarted, true);
    assert.equal(terminal.error.retryable, false);
  }
});

function decoded(frame: Buffer): Record<string, unknown> {
  return decode(frame) as Record<string, unknown>;
}
