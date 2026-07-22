import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VoiceTurnManager,
  type TurnManagerClock,
  type TurnManagerEvent,
  type TurnManagerTimerHandle,
} from '../../src/voice/turn-manager';

type ScheduledTimer = {
  readonly id: number;
  readonly dueMs: number;
  readonly callback: () => void;
  cleared: boolean;
  fired: boolean;
};

class FakeClock implements TurnManagerClock {
  private timeMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  now(): number {
    return this.timeMs;
  }

  setTimeout(
    callback: () => void,
    delayMs: number
  ): TurnManagerTimerHandle {
    const timer: ScheduledTimer = {
      id: this.nextId++,
      dueMs: this.timeMs + delayMs,
      callback,
      cleared: false,
      fired: false,
    };
    this.timers.set(timer.id, timer);
    return timer.id;
  }

  clearTimeout(handle: TurnManagerTimerHandle): void {
    const timer = this.timers.get(handle as number);
    if (timer) timer.cleared = true;
  }

  advanceBy(durationMs: number): void {
    const targetMs = this.timeMs + durationMs;

    for (;;) {
      const next = [...this.timers.values()]
        .filter(
          timer =>
            !timer.cleared && !timer.fired && timer.dueMs <= targetMs
        )
        .sort((left, right) => left.dueMs - right.dueMs || left.id - right.id)[0];

      if (!next) break;
      this.timeMs = next.dueMs;
      next.fired = true;
      next.callback();
    }

    this.timeMs = targetMs;
  }

  captureLatestCallback(): () => void {
    const timer = [...this.timers.values()].at(-1);
    assert.ok(timer);
    return timer.callback;
  }
}

function setup(endpointingDelayMs = 100): {
  clock: FakeClock;
  events: TurnManagerEvent[];
  manager: VoiceTurnManager;
} {
  const clock = new FakeClock();
  const events: TurnManagerEvent[] = [];
  const manager = new VoiceTurnManager({
    callId: 'call-1',
    conversationId: 'conversation-1',
    endpointingDelayMs,
    clock,
    onEvent: event => events.push(event),
  });

  return { clock, events, manager };
}

test('starts after a reserved generation and remains monotonic through barge-in', () => {
  const clock = new FakeClock();
  const manager = new VoiceTurnManager({
    callId: 'call-1',
    conversationId: 'conversation-1',
    initialGeneration: 1,
    endpointingDelayMs: 100,
    clock,
  });

  const firstUserTurn = manager.speechStarted();
  assert.equal(firstUserTurn.turn.generation, 2);
  manager.handleTranscript({
    turn: firstUserTurn.turn,
    text: 'Первый вопрос',
    isFinal: true,
  });
  manager.speechStopped(firstUserTurn.turn);
  clock.advanceBy(100);

  const nextUserTurn = manager.speechStarted();
  assert.equal(nextUserTurn.turn.generation, 3);
  assert.equal(firstUserTurn.signal.aborted, true);
  assert.equal(firstUserTurn.signal.reason, 'barge-in');
});

test('debounces VAD endpointing and commits the latest STT result', () => {
  const { clock, events, manager } = setup();
  const lease = manager.speechStarted();

  manager.handleTranscript({
    turn: lease.turn,
    text: 'хочу узнать',
    isFinal: false,
  });
  manager.speechStopped(lease.turn);

  clock.advanceBy(75);
  manager.handleTranscript({
    turn: lease.turn,
    text: 'хочу узнать стоимость',
    isFinal: true,
  });
  clock.advanceBy(99);

  assert.deepEqual(
    events.map(event => event.type),
    ['user_turn_started']
  );

  clock.advanceBy(1);
  assert.deepEqual(
    events.map(event => event.type),
    ['user_turn_started', 'user_turn_committed']
  );

  const committed = events[1]!;
  assert.equal(committed.type, 'user_turn_committed');
  if (committed.type !== 'user_turn_committed') return;
  assert.equal(committed.transcript, 'хочу узнать стоимость');
  assert.equal(committed.transcriptIsFinal, true);
  assert.equal(committed.turn.generation, 1);
  assert.equal(committed.signal, lease.signal);
});

test('speech resumed during debounce keeps the same generation', () => {
  const { clock, events, manager } = setup();
  const first = manager.speechStarted();
  manager.handleTranscript({
    turn: first.turn,
    text: 'первый фрагмент',
    isFinal: false,
  });
  manager.speechStopped(first.turn);

  clock.advanceBy(50);
  const resumed = manager.speechStarted();
  assert.equal(resumed.turn, first.turn);

  clock.advanceBy(100);
  assert.deepEqual(
    events.map(event => event.type),
    ['user_turn_started']
  );

  manager.handleTranscript({
    turn: first.turn,
    text: 'первый фрагмент и продолжение',
    isFinal: true,
  });
  manager.speechStopped(first.turn);
  clock.advanceBy(100);

  assert.equal(events[1]?.type, 'user_turn_committed');
});

test('barge-in synchronously invalidates and aborts LLM and TTS work', () => {
  const { clock, events, manager } = setup();
  const first = manager.speechStarted();
  manager.handleTranscript({
    turn: first.turn,
    text: 'первый вопрос',
    isFinal: true,
  });
  manager.speechStopped(first.turn);
  clock.advanceBy(100);

  let llmCancelled = 0;
  let ttsCancelled = 0;
  first.signal.addEventListener('abort', () => llmCancelled++);
  first.signal.addEventListener('abort', () => ttsCancelled++);

  const next = manager.speechStarted();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason, 'barge-in');
  assert.equal(llmCancelled, 1);
  assert.equal(ttsCancelled, 1);
  assert.equal(manager.isCurrent(first.turn), false);
  assert.equal(manager.isCurrent(next.turn), true);
  assert.equal(next.turn.generation, first.turn.generation + 1);

  assert.deepEqual(
    events.map(event => event.type),
    [
      'user_turn_started',
      'user_turn_committed',
      'barge_in',
      'cancelled',
      'user_turn_started',
    ]
  );
  const bargeIn = events[2]!;
  assert.equal(bargeIn.type, 'barge_in');
  if (bargeIn.type !== 'barge_in') return;
  assert.equal(bargeIn.interruptedTurn, first.turn);
  assert.equal(bargeIn.nextTurn, next.turn);
});

test('stale timers and tagged STT callbacks cannot commit a newer turn', () => {
  const { clock, events, manager } = setup();
  const first = manager.speechStarted();
  manager.handleTranscript({
    turn: first.turn,
    text: 'старый вопрос',
    isFinal: true,
  });
  manager.speechStopped(first.turn);
  const staleEndpointCallback = clock.captureLatestCallback();

  clock.advanceBy(100);
  const next = manager.speechStarted();

  assert.equal(
    manager.handleTranscript({
      turn: first.turn,
      text: 'запоздавший старый результат',
      isFinal: true,
    }),
    undefined
  );
  manager.speechStopped(first.turn);
  staleEndpointCallback();

  assert.equal(manager.current?.turn, next.turn);
  assert.deepEqual(
    events.filter(event => event.type === 'user_turn_committed').length,
    1
  );
});

test('guard suppresses stale downstream chunks after barge-in', () => {
  const { clock, manager } = setup();
  const first = manager.speechStarted();
  manager.handleTranscript({
    turn: first.turn,
    text: 'старый вопрос',
    isFinal: true,
  });
  manager.speechStopped(first.turn);
  clock.advanceBy(100);

  const chunks: string[] = [];
  const guarded = manager.guard(first.turn, (chunk: string) => {
    chunks.push(chunk);
  });
  guarded('актуальный');

  manager.speechStarted();
  guarded('устаревший');
  assert.deepEqual(chunks, ['актуальный']);
});

test('a final STT result can endpoint without VAD events', () => {
  const { clock, events, manager } = setup();
  const lease = manager.handleTranscript({
    text: 'запрос без событий VAD',
    isFinal: true,
  });
  assert.ok(lease);

  clock.advanceBy(100);
  assert.deepEqual(
    events.map(event => event.type),
    ['user_turn_started', 'user_turn_committed']
  );
});

test('empty endpoint is cancelled and the next generation increases', () => {
  const { clock, events, manager } = setup();
  const empty = manager.speechStarted();
  manager.speechStopped(empty.turn);
  clock.advanceBy(100);

  assert.equal(empty.signal.aborted, true);
  assert.equal(empty.signal.reason, 'empty-transcript');
  assert.equal(events[1]?.type, 'cancelled');

  const next = manager.speechStarted();
  assert.ok(next.turn.generation > empty.turn.generation);
  assert.notEqual(next.turn.turnId, empty.turn.turnId);
});

test('completing downstream work prevents a later turn from being a barge-in', () => {
  const { clock, events, manager } = setup();
  const first = manager.speechStarted();
  manager.handleTranscript({
    turn: first.turn,
    text: 'готово',
    isFinal: true,
  });
  manager.speechStopped(first.turn);
  clock.advanceBy(100);

  assert.equal(manager.complete(first.turn), true);
  assert.equal(manager.isCurrent(first.turn), false);
  const second = manager.speechStarted();

  assert.equal(first.signal.aborted, false);
  assert.ok(second.turn.generation > first.turn.generation);
  assert.equal(events.some(event => event.type === 'barge_in'), false);
});

test('dispose cancels the active generation exactly once', () => {
  const { events, manager } = setup();
  const lease = manager.speechStarted();

  manager.dispose();
  manager.dispose();

  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.signal.reason, 'disposed');
  assert.equal(
    events.filter(event => event.type === 'cancelled').length,
    1
  );
  assert.throws(() => manager.speechStarted(), /disposed/);
});
