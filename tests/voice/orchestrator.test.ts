import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StaleVoiceGenerationError,
  VoiceResponseOrchestrator,
  type ComplexityClassifier,
  type ModelCandidate,
  type ModelRunner,
  type ModelRunnerRequest,
  type OrchestratorClock,
} from '../../src/voice/orchestrator';
import type { TurnRef } from '../../src/voice/providers/tts';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function candidate(
  text: string,
  key: string,
  value: string,
  extra: Partial<ModelCandidate> = {}
): ModelCandidate {
  return {
    confidence: 0.99,
    safeToCommit: true,
    segments: [
      {
        text,
        assertions: [{ key, value }],
      },
    ],
    ...extra,
  };
}

function turn(generation = 1): TurnRef {
  return {
    callId: 'call-1',
    conversationId: 'conversation-1',
    turnId: `turn-${generation}`,
    generation,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
}

class FakeClock implements OrchestratorClock {
  private currentMs = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { atMs: number; callback: () => void }
  >();

  now(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, {
      atMs: this.currentMs + delayMs,
      callback,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(delayMs: number): void {
    this.currentMs += delayMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.atMs <= this.currentMs)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.atMs - right.atMs || leftId - rightId
        )[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

test('returns a safe draft immediately and starts fast and medium in parallel', async () => {
  const fastResult = deferred<ModelCandidate>();
  const mediumResult = deferred<ModelCandidate>();
  const starts: string[] = [];
  const spoken: string[] = [];

  const fast: ModelRunner = {
    name: 'fast-test',
    run: async () => {
      starts.push('fast');
      return fastResult.promise;
    },
  };
  const medium: ModelRunner = {
    name: 'medium-test',
    run: async () => {
      starts.push('medium');
      return mediumResult.promise;
    },
  };
  const orchestrator = new VoiceResponseOrchestrator({
    fast,
    medium,
  });

  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Расскажите о тарифе',
    safeDraft: 'Секунду, уточняю.',
    signal: new AbortController().signal,
    onCommit: commit => {
      spoken.push(commit.segment.text);
    },
  });

  assert.equal(run.draft.kind, 'draft');
  assert.equal(run.draft.text, 'Секунду, уточняю.');
  assert.deepEqual(starts, []);

  await flushMicrotasks();
  assert.deepEqual(starts.sort(), ['fast', 'medium']);

  fastResult.resolve(candidate('Тариф доступен.', 'tariff.available', 'yes'));
  await flushMicrotasks();
  assert.deepEqual(spoken, ['Тариф доступен.']);

  mediumResult.resolve(
    candidate('Подключение занимает один день.', 'setup.days', '1')
  );
  const result = await run.completed;

  assert.equal(result.status, 'completed');
  assert.deepEqual(spoken, [
    'Тариф доступен.',
    'Подключение занимает один день.',
  ]);
  assert.deepEqual(
    result.committed.map(commit => commit.segment.sequence),
    [0, 1]
  );
  assert.equal(result.metrics.tiers.deep.state, 'not_started');
});

test('commits safe non-factual segments with empty assertions from fast and medium', async () => {
  const fastResult = deferred<ModelCandidate>();
  const mediumResult = deferred<ModelCandidate>();
  const spoken: string[] = [];
  const orchestrator = new VoiceResponseOrchestrator({
    fast: {
      name: 'fast-test',
      run: () => fastResult.promise,
    },
    medium: {
      name: 'medium-test',
      run: () => mediumResult.promise,
    },
  });
  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Помоги подобрать вариант',
    safeDraft: 'Секунду.',
    signal: new AbortController().signal,
    onCommit: commit => {
      spoken.push(commit.segment.text);
    },
  });

  await flushMicrotasks();
  fastResult.resolve({
    confidence: 0.99,
    safeToCommit: true,
    segments: [{ text: 'Конечно, помогу.', assertions: [] }],
  });
  await flushMicrotasks();
  mediumResult.resolve({
    confidence: 0.99,
    safeToCommit: true,
    segments: [{ text: 'Давайте уточним детали.', assertions: [] }],
  });

  const result = await run.completed;
  assert.deepEqual(spoken, [
    'Конечно, помогу.',
    'Давайте уточним детали.',
  ]);
  assert.deepEqual(
    result.committed.map(commit => commit.assertions),
    [[], []]
  );
  assert.equal(result.metrics.committedSegments, 2);
  assert.equal(result.metrics.invalidSegments, 0);
});

test('does not repeat an identical non-factual segment from a later tier', async () => {
  const repeated = {
    confidence: 0.99,
    safeToCommit: true,
    segments: [{ text: 'Конечно, помогу.', assertions: [] }],
  } satisfies ModelCandidate;
  const orchestrator = new VoiceResponseOrchestrator({
    fast: {
      name: 'fast-test',
      run: async () => repeated,
    },
    medium: {
      name: 'medium-test',
      run: async () => repeated,
    },
  });

  const result = await orchestrator.start({
    turn: turn(),
    prompt: 'Помоги подобрать вариант',
    safeDraft: 'Секунду.',
    signal: new AbortController().signal,
  }).completed;

  assert.deepEqual(
    result.committed.map(commit => commit.segment.text),
    ['Конечно, помогу.']
  );
  assert.equal(result.metrics.rejectedDuplicates, 1);
});

test('rejects a correction of spoken meaning but permits additive detail', async () => {
  const fastResult = deferred<ModelCandidate>();
  const mediumResult = deferred<ModelCandidate>();

  const orchestrator = new VoiceResponseOrchestrator({
    fast: {
      name: 'fast-test',
      run: () => fastResult.promise,
    },
    medium: {
      name: 'medium-test',
      run: () => mediumResult.promise,
    },
  });
  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Сколько стоит и когда подключите?',
    safeDraft: 'Проверяю условия.',
    signal: new AbortController().signal,
  });

  await flushMicrotasks();
  fastResult.resolve(candidate('Стоимость — 10 000 ₸.', 'price.kzt', '10000'));
  await flushMicrotasks();
  mediumResult.resolve({
    confidence: 0.99,
    safeToCommit: true,
    segments: [
      {
        text: 'Поправка: стоимость — 12 000 ₸.',
        assertions: [{ key: 'price.kzt', value: '12000' }],
      },
      {
        text: 'Подключение возможно завтра.',
        assertions: [{ key: 'setup.date', value: 'tomorrow' }],
      },
    ],
  });

  const result = await run.completed;
  assert.deepEqual(
    result.committed.map(commit => commit.segment.text),
    ['Стоимость — 10 000 ₸.', 'Подключение возможно завтра.']
  );
  assert.equal(result.metrics.rejectedContradictions, 1);
  assert.equal(result.metrics.committedSegments, 2);
});

test('starts deep immediately for high complexity and only once', async () => {
  const calls: ModelRunnerRequest[] = [];
  const makeRunner = (name: string, key: string): ModelRunner => ({
    name,
    run: async request => {
      calls.push(request);
      return candidate(`${name} result`, key, 'yes');
    },
  });

  const orchestrator = new VoiceResponseOrchestrator({
    fast: makeRunner('fast', 'fast.answer'),
    medium: {
      name: 'medium',
      run: async request => {
        calls.push(request);
        return candidate('medium result', 'medium.answer', 'yes', {
          requiresDeep: true,
        });
      },
    },
    deep: makeRunner('deep', 'deep.answer'),
  });
  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Проведи сложный анализ архитектуры',
    safeDraft: 'Анализирую.',
    complexity: 0.95,
    signal: new AbortController().signal,
  });

  const result = await run.completed;
  assert.equal(
    calls.filter(call => call.tier === 'deep').length,
    1
  );
  assert.equal(result.metrics.deepTrigger, 'complexity');
  assert.equal(result.metrics.tiers.deep.state, 'succeeded');
});

test('medium can request deep without speculative deep calls', async () => {
  const mediumResult = deferred<ModelCandidate>();
  let deepCalls = 0;
  const orchestrator = new VoiceResponseOrchestrator({
    fast: {
      name: 'fast',
      run: async () => ({
        confidence: 0,
        safeToCommit: false,
        segments: [],
      }),
    },
    medium: {
      name: 'medium',
      run: () => mediumResult.promise,
    },
    deep: {
      name: 'deep',
      run: async () => {
        deepCalls++;
        return candidate('Глубокий ответ.', 'deep.complete', 'yes');
      },
    },
  });
  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Обычный вопрос',
    safeDraft: 'Уточняю.',
    complexity: 0.1,
    signal: new AbortController().signal,
  });

  await flushMicrotasks();
  assert.equal(deepCalls, 0);

  mediumResult.resolve({
    confidence: 0.5,
    safeToCommit: false,
    requiresDeep: true,
    segments: [],
  });
  await flushMicrotasks();
  assert.equal(deepCalls, 1);

  const result = await run.completed;
  assert.equal(deepCalls, 1);
  assert.equal(result.metrics.deepTrigger, 'medium');
});

test('classifier can request deep independently of medium', async () => {
  const classifierResult = deferred<{
    requiresDeep: boolean;
    reason?: string;
  }>();
  const mediumResult = deferred<ModelCandidate>();
  let deepCalls = 0;
  const classifier: ComplexityClassifier = {
    name: 'classifier-test',
    classify: () => classifierResult.promise,
  };
  const orchestrator = new VoiceResponseOrchestrator({
    fast: {
      name: 'fast',
      run: async () => ({
        confidence: 0,
        safeToCommit: false,
        segments: [],
      }),
    },
    medium: {
      name: 'medium',
      run: () => mediumResult.promise,
    },
    deep: {
      name: 'deep',
      run: async () => {
        deepCalls++;
        return candidate('Проверенный ответ.', 'deep.checked', 'yes');
      },
    },
    classifier,
  });
  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Вопрос с неочевидной предметной сложностью',
    safeDraft: 'Проверяю.',
    complexity: 0.1,
    signal: new AbortController().signal,
  });

  await flushMicrotasks();
  assert.equal(deepCalls, 0);
  classifierResult.resolve({
    requiresDeep: true,
    reason: 'domain risk',
  });
  await flushMicrotasks();
  assert.equal(deepCalls, 1);

  mediumResult.resolve({
    confidence: 0.5,
    safeToCommit: false,
    segments: [],
  });
  const result = await run.completed;
  assert.equal(result.metrics.deepTrigger, 'classifier');
  assert.equal(result.metrics.classifier?.state, 'succeeded');
});

test('a newer generation cancels the old run and stale generations are rejected', async () => {
  const observedSignals: AbortSignal[] = [];
  const runner: ModelRunner = {
    name: 'generation-aware',
    run: request => {
      observedSignals.push(request.signal);
      if (request.turn.generation === 1) {
        return new Promise<ModelCandidate>(() => undefined);
      }
      return Promise.resolve(
        candidate('Актуальный ответ.', 'generation', '2')
      );
    },
  };
  const orchestrator = new VoiceResponseOrchestrator({
    fast: runner,
    medium: runner,
  });
  const oldRun = orchestrator.start({
    turn: turn(1),
    prompt: 'Старый вопрос',
    safeDraft: 'Секунду.',
    signal: new AbortController().signal,
  });
  await flushMicrotasks();

  const newRun = orchestrator.start({
    turn: turn(2),
    prompt: 'Новый вопрос',
    safeDraft: 'Секунду.',
    signal: new AbortController().signal,
  });

  const [oldResult, newResult] = await Promise.all([
    oldRun.completed,
    newRun.completed,
  ]);
  assert.equal(oldResult.status, 'cancelled');
  assert.equal(oldResult.committed.length, 0);
  assert.equal(newResult.status, 'completed');
  assert.equal(newResult.committed.length, 1);
  assert.equal(
    observedSignals
      .filter(signal => signal.aborted)
      .every(signal => signal.reason === 'superseded'),
    true
  );
  assert.throws(
    () =>
      orchestrator.start({
        turn: turn(1),
        prompt: 'Просроченный вопрос',
        safeDraft: 'Секунду.',
        signal: new AbortController().signal,
      }),
    StaleVoiceGenerationError
  );
});

test('enforces model deadlines with a deterministic clock and reports metrics', async () => {
  const clock = new FakeClock();
  const never: ModelRunner = {
    name: 'never',
    run: () => new Promise<ModelCandidate>(() => undefined),
  };
  const orchestrator = new VoiceResponseOrchestrator({
    fast: never,
    medium: never,
    clock,
    deadlinesMs: {
      fast: 10,
      medium: 20,
      total: 50,
    },
  });
  const run = orchestrator.start({
    turn: turn(),
    prompt: 'Ответь',
    safeDraft: 'Думаю.',
    signal: new AbortController().signal,
  });

  await flushMicrotasks();
  clock.advanceBy(10);
  await flushMicrotasks();
  clock.advanceBy(10);
  await flushMicrotasks();

  const result = await run.completed;
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.tiers.fast.state, 'timed_out');
  assert.equal(result.metrics.tiers.medium.state, 'timed_out');
  assert.equal(result.metrics.totalMs, 20);
  assert.equal(result.metrics.committedSegments, 0);
});
