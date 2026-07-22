import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicComplexityClassifier,
  AnthropicModelRunner,
  AnthropicVoiceModelError,
  createAnthropicLowLatencyControls,
  type AnthropicCandidateLimits,
  type AnthropicClassifierLimits,
  type AnthropicMessageResult,
  type AnthropicMessagesClient,
  type AnthropicVoiceMessageCreateParams,
} from '../../src/voice/models/anthropic-runner';
import type {
  ComplexityClassifierRequest,
  ModelRunnerRequest,
} from '../../src/voice/orchestrator';

type RecordedCall = Readonly<{
  body: AnthropicVoiceMessageCreateParams;
  options?: Anthropic.RequestOptions;
}>;

const CANDIDATE_LIMITS: AnthropicCandidateLimits = Object.freeze({
  maxSegments: 3,
  maxSegmentCharacters: 120,
  maxAssertionsPerSegment: 4,
  maxAssertionKeyCharacters: 40,
  maxAssertionValueCharacters: 80,
  maxPromptCharacters: 500,
  maxContextCharacters: 1_000,
  maxResponseCharacters: 2_000,
});

const CLASSIFIER_LIMITS: AnthropicClassifierLimits = Object.freeze({
  maxPromptCharacters: 500,
  maxContextCharacters: 1_000,
  maxResponseCharacters: 500,
  maxReasonCharacters: 100,
});

function clientReturning(
  result: AnthropicMessageResult,
  calls: RecordedCall[] = []
): AnthropicMessagesClient {
  return {
    messages: {
      create: async (body, options) => {
        calls.push({ body, options });
        return result;
      },
    },
  };
}

function textResult(
  text: string,
  stopReason = 'end_turn'
): AnthropicMessageResult {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
  };
}

function runnerRequest(
  overrides: Partial<ModelRunnerRequest> = {}
): ModelRunnerRequest {
  return {
    tier: 'fast',
    prompt: 'Сколько стоит подключение?',
    context: { price: '10 000 ₸' },
    turn: {
      callId: 'call-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      generation: 1,
    },
    signal: new AbortController().signal,
    deadlineAtMs: 1_500,
    ...overrides,
  };
}

function classifierRequest(
  overrides: Partial<ComplexityClassifierRequest> = {}
): ComplexityClassifierRequest {
  return {
    prompt: 'Сравни два тарифа и рассчитай экономию за год.',
    context: { plans: ['A', 'B'] },
    turn: {
      callId: 'call-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      generation: 1,
    },
    signal: new AbortController().signal,
    deadlineAtMs: 2_000,
    estimatedComplexity: 0.8,
    ...overrides,
  };
}

test('parses a fenced JSON candidate and propagates SDK request controls', async () => {
  const calls: RecordedCall[] = [];
  const client = clientReturning(
    textResult(`\`\`\`json
{
  "segments": [{
    "text": "Подключение стоит 10 000 тенге.",
    "assertions": [{"key": "setup.price_kzt", "value": "10000"}]
  }],
  "confidence": 0.98,
  "safeToCommit": true,
  "requiresDeep": false
}
\`\`\``),
    calls
  );
  const runner = new AnthropicModelRunner({
    client,
    name: 'voice-fast',
    model: 'model-from-constructor',
    maxTokens: 321,
    temperature: 0.2,
    limits: CANDIDATE_LIMITS,
    now: () => 1_000,
  });
  const request = runnerRequest({
    trustedPolicy: 'Никогда не обещай скидку без подтверждения.',
  });

  const candidate = await runner.run(request);

  assert.equal(runner.name, 'voice-fast');
  assert.deepEqual(candidate, {
    segments: [
      {
        text: 'Подключение стоит 10 000 тенге.',
        assertions: [{ key: 'setup.price_kzt', value: '10000' }],
      },
    ],
    confidence: 0.98,
    safeToCommit: true,
    requiresDeep: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'model-from-constructor');
  assert.equal(calls[0].body.max_tokens, 321);
  assert.equal(calls[0].body.temperature, 0.2);
  assert.match(String(calls[0].body.system), /короткими, естественными/);
  assert.match(String(calls[0].body.system), /Для уровня fast/);
  assert.match(
    String(calls[0].body.system),
    /Никогда не обещай скидку/
  );
  assert.match(
    String(calls[0].body.system),
    /Не выдумывай факты/
  );
  assert.match(
    String(calls[0].body.messages[0].content),
    /Уровень модели: fast/
  );
  assert.doesNotMatch(
    String(calls[0].body.messages[0].content),
    /Никогда не обещай скидку/
  );
  assert.equal(calls[0].options?.signal, request.signal);
  assert.equal(calls[0].options?.timeout, 500);
  assert.equal(calls[0].options?.maxRetries, 0);
});

test('builds a Sonnet 5 low-latency body without sampling parameters', async () => {
  const calls: RecordedCall[] = [];
  const controls = createAnthropicLowLatencyControls(
    'claude-sonnet-5',
    0.15
  );
  const runner = new AnthropicModelRunner({
    client: clientReturning(
      {
        content: [
          { type: 'thinking' },
          {
            type: 'text',
            text: JSON.stringify({
              segments: [
                {
                  text: 'Подключение стоит 10 000 тенге.',
                  assertions: [
                    { key: 'setup.price_kzt', value: '10000' },
                  ],
                },
              ],
              confidence: 0.98,
              safeToCommit: true,
              requiresDeep: false,
            }),
          },
        ],
        stop_reason: 'end_turn',
      },
      calls
    ),
    name: 'voice-medium',
    model: 'claude-sonnet-5',
    maxTokens: 640,
    ...controls,
    limits: CANDIDATE_LIMITS,
    now: () => 1_000,
  });

  const result = await runner.run(
    runnerRequest({
      tier: 'medium',
      deadlineAtMs: 1_800,
    })
  );

  assert.equal(result.safeToCommit, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(calls[0].body, 'temperature'),
    false
  );
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
});

test('enforces Sonnet 5 capabilities even if a caller supplies temperature', async () => {
  const calls: RecordedCall[] = [];
  const runner = new AnthropicModelRunner({
    client: clientReturning(
      textResult(
        JSON.stringify({
          segments: [
            {
              text: 'Хорошо.',
              assertions: [],
            },
          ],
          confidence: 0.95,
          safeToCommit: true,
          requiresDeep: false,
        })
      ),
      calls
    ),
    name: 'direct-sonnet-5',
    model: 'claude-sonnet-5-20260719',
    maxTokens: 100,
    temperature: 0.15,
    limits: CANDIDATE_LIMITS,
    now: () => 0,
  });

  await runner.run(runnerRequest({ deadlineAtMs: 100 }));

  assert.equal('temperature' in calls[0].body, false);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
});

test('keeps configured sampling behavior for non-Sonnet-5 models', async () => {
  assert.deepEqual(
    createAnthropicLowLatencyControls(
      'claude-haiku-4-5-20251001',
      0.1
    ),
    { temperature: 0.1 }
  );
  assert.deepEqual(
    createAnthropicLowLatencyControls('claude-opus-4-8'),
    {}
  );
});

test('strictly rejects extra fields and candidate limit violations', async () => {
  const extraFieldRunner = new AnthropicModelRunner({
    client: clientReturning(
      textResult(
        JSON.stringify({
          segments: [
            {
              text: 'Да.',
              assertions: [{ key: 'answer', value: 'yes' }],
            },
          ],
          confidence: 1,
          safeToCommit: true,
          requiresDeep: false,
          debug: 'must-not-pass',
        })
      )
    ),
    name: 'strict-runner',
    model: 'configured-model',
    maxTokens: 100,
    limits: CANDIDATE_LIMITS,
    now: () => 0,
  });

  await assert.rejects(
    extraFieldRunner.run(runnerRequest({ deadlineAtMs: 100 })),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'invalid_response' &&
      /unsupported field/.test(error.message)
  );

  const longTextRunner = new AnthropicModelRunner({
    client: clientReturning(
      textResult(
        JSON.stringify({
          segments: [
            {
              text: 'слишком длинно',
              assertions: [{ key: 'answer', value: 'yes' }],
            },
          ],
          confidence: 1,
          safeToCommit: true,
          requiresDeep: false,
        })
      )
    ),
    name: 'limited-runner',
    model: 'configured-model',
    maxTokens: 100,
    limits: { ...CANDIDATE_LIMITS, maxSegmentCharacters: 5 },
    now: () => 0,
  });

  await assert.rejects(
    longTextRunner.run(runnerRequest({ deadlineAtMs: 100 })),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'invalid_response' &&
      /configured limit/.test(error.message)
  );
});

test('rejects malformed JSON without leaking the provider output', async () => {
  const secret = 'sk-ant-sensitive-provider-payload';
  const runner = new AnthropicModelRunner({
    client: clientReturning(textResult(`not-json ${secret}`)),
    name: 'sanitized-runner',
    model: 'configured-model',
    maxTokens: 100,
    limits: CANDIDATE_LIMITS,
    now: () => 0,
  });

  await assert.rejects(
    runner.run(runnerRequest({ deadlineAtMs: 100 })),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'invalid_response' &&
      !error.message.includes(secret)
  );
});

test('sanitizes SDK failures and does not expose model or provider details', async () => {
  const secret = 'request-id-and-secret-body';
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        throw new Error(secret);
      },
    },
  };
  const runner = new AnthropicModelRunner({
    client,
    name: 'failure-runner',
    model: 'private-model-id',
    maxTokens: 100,
    limits: CANDIDATE_LIMITS,
    now: () => 0,
  });

  await assert.rejects(
    runner.run(runnerRequest({ deadlineAtMs: 100 })),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'request_failed' &&
      !error.message.includes(secret) &&
      !error.message.includes('private-model-id')
  );
});

test('does not call the SDK after cancellation or an expired deadline', async () => {
  let callCount = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        callCount++;
        return textResult('{}');
      },
    },
  };
  const runner = new AnthropicModelRunner({
    client,
    name: 'deadline-runner',
    model: 'configured-model',
    maxTokens: 100,
    limits: CANDIDATE_LIMITS,
    now: () => 100,
  });
  const controller = new AbortController();
  controller.abort('barge-in');

  await assert.rejects(
    runner.run(runnerRequest({ signal: controller.signal })),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'cancelled'
  );
  await assert.rejects(
    runner.run(runnerRequest({ deadlineAtMs: 100 })),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'deadline_exceeded'
  );
  assert.equal(callCount, 0);
});

test('classifies complexity from fenced JSON with configured request options', async () => {
  const calls: RecordedCall[] = [];
  const classifier = new AnthropicComplexityClassifier({
    client: clientReturning(
      textResult(
        '```json\n{"requiresDeep":true,"reason":"Нужен расчёт."}\n```'
      ),
      calls
    ),
    name: 'voice-complexity',
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 99,
    temperature: 0,
    limits: CLASSIFIER_LIMITS,
    now: () => 1_000,
  });
  const request = classifierRequest();

  const result = await classifier.classify(request);

  assert.deepEqual(result, {
    requiresDeep: true,
    reason: 'Нужен расчёт.',
  });
  assert.equal(classifier.name, 'voice-complexity');
  assert.equal(
    calls[0].body.model,
    'claude-haiku-4-5-20251001'
  );
  assert.equal(calls[0].body.max_tokens, 99);
  assert.equal(calls[0].body.temperature, 0);
  assert.equal('thinking' in calls[0].body, false);
  assert.match(
    String(calls[0].body.messages[0].content),
    /Предварительная оценка сложности: 0.8/
  );
  assert.equal(calls[0].options?.signal, request.signal);
  assert.equal(calls[0].options?.timeout, 1_000);
});

test('classifier validates its JSON schema and reason limit', async () => {
  const classifier = new AnthropicComplexityClassifier({
    client: clientReturning(
      textResult(
        '{"requiresDeep":true,"reason":"слишком длинная причина"}'
      )
    ),
    name: 'strict-classifier',
    model: 'configured-model',
    maxTokens: 50,
    limits: { ...CLASSIFIER_LIMITS, maxReasonCharacters: 5 },
    now: () => 0,
  });

  await assert.rejects(
    classifier.classify(
      classifierRequest({ deadlineAtMs: 100 })
    ),
    (error: unknown) =>
      error instanceof AnthropicVoiceModelError &&
      error.code === 'invalid_response' &&
      /configured limit/.test(error.message)
  );
});
