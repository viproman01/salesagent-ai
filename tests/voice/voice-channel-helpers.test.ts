import assert from 'node:assert/strict';
import test from 'node:test';
import type { VoiceRuntimeEvent } from '../../src/voice/runtime';
import {
  createBoundedVoiceWebSocketSender,
  deliverFinalTranscript,
  ProvisionalVoiceSessionRegistry,
  SerializedStartupFrameRouter,
  VoiceEventGenerationGate,
  VoiceSessionDrainTracker,
  type VoiceWebSocketLike,
} from '../../src/voice/telephony/voice-channel-helpers';
import { VoximplantProtocolError } from '../../src/voice/telephony/voximplant-media';

class FakeVoiceWebSocket implements VoiceWebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Buffer | string> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  terminateCalls = 0;
  sendError: Error | undefined;

  send(
    data: Buffer | string,
    _options: { binary: boolean },
    callback: (error?: Error) => void
  ): void {
    this.sent.push(data);
    callback(this.sendError);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = 2;
  }

  terminate(): void {
    this.terminateCalls++;
    this.readyState = 3;
  }
}

test('outbound WebSocket backpressure closes and throws instead of losing audio', () => {
  const socket = new FakeVoiceWebSocket();
  socket.bufferedAmount = 8;
  const send = createBoundedVoiceWebSocketSender({
    socket,
    openState: 1,
    maxBufferedBytes: 10,
  });

  assert.throws(
    () => send(Buffer.alloc(3)),
    (error: unknown) =>
      error instanceof VoximplantProtocolError &&
      error.code === 'backpressure'
  );
  assert.deepEqual(socket.closes, [
    { code: 1011, reason: 'Voice transport backpressure' },
  ]);
  assert.deepEqual(socket.sent, []);
});

test('asynchronous WebSocket send failure terminates the transport', () => {
  const socket = new FakeVoiceWebSocket();
  const failure = new Error('write failed');
  socket.sendError = failure;
  const observed: Error[] = [];
  const send = createBoundedVoiceWebSocketSender({
    socket,
    openState: 1,
    maxBufferedBytes: 10,
    onSendError: error => observed.push(error),
  });

  send(Buffer.alloc(1));

  assert.deepEqual(observed, [failure]);
  assert.equal(socket.terminateCalls, 1);
});

test('generation gate rejects stale audio after a newer playback generation', () => {
  const gate = new VoiceEventGenerationGate();
  const newer: VoiceRuntimeEvent = {
    type: 'playback_clear',
    generation: 4,
    reason: 'barge-in',
  };
  const staleAudio: VoiceRuntimeEvent = {
    type: 'audio',
    generation: 3,
    data: Buffer.alloc(160),
  };
  const currentAudio: VoiceRuntimeEvent = {
    type: 'audio',
    generation: 4,
    data: Buffer.alloc(160),
  };

  assert.equal(gate.accept(newer), true);
  assert.equal(gate.accept(staleAudio), false);
  assert.equal(gate.accept(currentAudio), true);
  assert.equal(gate.currentGeneration, 4);
});

test('persistence failure occurs after playback flush and is contained', async () => {
  const order: string[] = [];
  const transcript: string[] = [];
  const storageError = new Error('database unavailable');

  const delivered = await deliverFinalTranscript({
    event: {
      type: 'transcript',
      text: 'Готовый ответ',
      isFinal: true,
      role: 'assistant',
    },
    transcript,
    finishPlayback: () => {
      order.push('flush');
    },
    persist: async () => {
      order.push('persist');
      throw storageError;
    },
    onPersistenceError: error => {
      assert.equal(error, storageError);
      order.push('reported');
    },
  });

  assert.equal(delivered, true);
  assert.deepEqual(order, ['flush', 'persist', 'reported']);
  assert.deepEqual(transcript, ['assistant: Готовый ответ']);
});

test('serialized startup drain preserves start/media/stop wire order', async () => {
  type Frame = 'start' | 'media' | 'stop';
  const handled: Frame[] = [];
  let releaseStart!: () => void;
  const startHeld = new Promise<void>(resolve => {
    releaseStart = resolve;
  });
  let startObserved!: () => void;
  const sawStart = new Promise<void>(resolve => {
    startObserved = resolve;
  });
  const failures: unknown[] = [];
  const router = new SerializedStartupFrameRouter<Frame>({
    maxQueuedBytes: 3,
    byteLength: () => 1,
    onFailure: error => failures.push(error),
  });

  router.enqueue('start');
  router.enqueue('media');
  const activation = router.activate(async frame => {
    handled.push(frame);
    if (frame === 'start') {
      startObserved();
      await startHeld;
    }
  });

  await sawStart;
  router.enqueue('stop');
  releaseStart();
  await activation;
  await router.idle();

  assert.deepEqual(handled, ['start', 'media', 'stop']);
  assert.deepEqual(failures, []);
});

test('startup queue overflow is surfaced through the failure boundary', async () => {
  const failures: unknown[] = [];
  const router = new SerializedStartupFrameRouter<Buffer>({
    maxQueuedBytes: 2,
    byteLength: frame => frame.length,
    onFailure: error => failures.push(error),
  });

  router.enqueue(Buffer.alloc(2));
  router.enqueue(Buffer.alloc(1));
  await router.idle();

  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof VoximplantProtocolError);
  assert.equal(
    (failures[0] as VoximplantProtocolError).code,
    'payload_too_large'
  );
});

test('early close and provisional cleanup leave no session reservation behind', () => {
  const registry = new ProvisionalVoiceSessionRegistry<{ id: string }>();

  assert.equal(registry.tryReserve('call-1'), true);
  assert.equal(registry.tryReserve('call-1'), false);
  assert.equal(registry.take('call-1'), undefined);
  const cancelledProvisional = { id: 'cancelled-conversation' };
  assert.equal(
    registry.register('call-1', cancelledProvisional),
    false
  );
  assert.equal(registry.take('call-1'), cancelledProvisional);
  registry.finishInitialization('call-1');
  assert.equal(registry.activeCount, 0);
  assert.equal(registry.initializingCount, 0);

  assert.equal(registry.tryReserve('call-1'), true);
  const provisional = { id: 'conversation-1' };
  assert.equal(registry.register('call-1', provisional), true);
  assert.equal(registry.take('call-1'), provisional);
  assert.equal(registry.take('call-1'), undefined);
  registry.finishInitialization('call-1');
  assert.equal(registry.activeCount, 0);
  assert.equal(registry.initializingCount, 0);
});

test('shutdown rejects new sessions and cancels provisional initialization', () => {
  const registry = new ProvisionalVoiceSessionRegistry<{ id: string }>();

  assert.equal(registry.tryReserve('initializing-call'), true);
  assert.equal(registry.tryReserve('active-call'), true);
  assert.equal(
    registry.register('active-call', { id: 'active-session' }),
    true
  );
  registry.finishInitialization('active-call');

  assert.deepEqual(
    registry.beginShutdown().sort(),
    ['active-call']
  );
  assert.equal(registry.isAccepting, false);
  assert.equal(registry.tryReserve('late-call'), false);
  assert.equal(
    registry.register(
      'initializing-call',
      { id: 'cancelled-session' }
    ),
    false
  );
  registry.finishInitialization('initializing-call');
  assert.equal(registry.get('initializing-call'), undefined);
  assert.deepEqual(
    registry.take('initializing-call'),
    { id: 'cancelled-session' }
  );
});

test('drain waits for cleanup added by an in-flight initialization', async () => {
  const tracker = new VoiceSessionDrainTracker();
  let finishInitialization!: () => void;
  let finishCleanup!: () => void;
  const initializationSignal = new Promise<void>(resolve => {
    finishInitialization = resolve;
  });
  const cleanupSignal = new Promise<void>(resolve => {
    finishCleanup = resolve;
  });
  const initialization = initializationSignal.then(() => {
    void tracker.track(cleanupSignal);
  });
  void tracker.track(initialization);

  const drain = tracker.drain(1_000);
  finishInitialization();
  await initialization;
  assert.equal(tracker.pendingCount, 1);
  finishCleanup();

  assert.deepEqual(
    await drain,
    { drained: true, pendingCount: 0 }
  );
});

test('concurrent finalization callers share one in-flight promise', async () => {
  const tracker = new VoiceSessionDrainTracker();
  let finishFinalization!: () => void;
  const finalizationSignal = new Promise<void>(resolve => {
    finishFinalization = resolve;
  });
  let finalizationCalls = 0;
  const finalize = (): Promise<void> => {
    finalizationCalls++;
    return finalizationSignal;
  };

  const first = tracker.runOnce('call-1', finalize);
  const concurrent = tracker.runOnce('call-1', finalize);
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(finalizationCalls, 1);

  finishFinalization();
  await Promise.all([first, concurrent]);
  assert.equal(tracker.getRunning('call-1'), undefined);

  await tracker.runOnce('call-1', finalize);
  assert.equal(finalizationCalls, 2);
});

test('drain returns a bounded timeout with unfinished work', async () => {
  const tracker = new VoiceSessionDrainTracker();
  void tracker.track(new Promise<void>(() => undefined));

  assert.deepEqual(
    await tracker.drain(5),
    { drained: false, pendingCount: 1 }
  );
});
