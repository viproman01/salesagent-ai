import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CerebrasModelRunner,
  CerebrasVoiceModelError,
  type CerebrasFetch,
} from '../../src/voice/models/cerebras-runner';
import type {
  ModelCandidate,
  ModelRunnerRequest,
} from '../../src/voice/orchestrator';

const LIMITS = Object.freeze({
  maxSegments: 3,
  maxSegmentCharacters: 240,
  maxAssertionsPerSegment: 8,
  maxAssertionKeyCharacters: 80,
  maxAssertionValueCharacters: 240,
  maxPromptCharacters: 4_000,
  maxContextCharacters: 24_000,
  maxResponseCharacters: 8_000,
});

const SAFE_CANDIDATE: ModelCandidate = Object.freeze({
  segments: Object.freeze([
    Object.freeze({
      text: 'Добрый день! Сейчас коротко поясню.',
      assertions: Object.freeze([]),
    }),
  ]),
  confidence: 0.95,
  safeToCommit: true,
  requiresDeep: false,
});

function request(
  overrides: Partial<ModelRunnerRequest> = {}
): ModelRunnerRequest {
  return {
    tier: 'fast',
    prompt: 'Кто вы и сколько это стоит?',
    context: { channel: 'voice' },
    trustedPolicy: 'Представляйся виртуальным помощником компании.',
    turn: {
      callId: 'call-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      generation: 1,
    },
    signal: new AbortController().signal,
    deadlineAtMs: 10_000,
    ...overrides,
  };
}

function completion(
  candidate: unknown = SAFE_CANDIDATE,
  finishReason = 'stop'
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: { content: JSON.stringify(candidate) },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function createRunner(
  fetchImpl: CerebrasFetch,
  overrides: Partial<ConstructorParameters<typeof CerebrasModelRunner>[0]> = {}
): CerebrasModelRunner {
  return new CerebrasModelRunner({
    name: 'voice-fast-cerebras',
    model: 'gemma-4-31b',
    apiKeys: ['key-one', 'key-two'],
    maxTokens: 120,
    temperature: 0,
    limits: LIMITS,
    fetch: fetchImpl,
    now: () => 1_000,
    ...overrides,
  });
}

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

describe('CerebrasModelRunner', () => {
  it('uses Gemma strict structured output with separated trusted policy', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const runner = createRunner(
      async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return completion();
      },
      { apiKeys: ['key-one'] }
    );

    const candidate = await runner.run(request());
    assert.deepEqual(candidate, SAFE_CANDIDATE);
    assert.equal(
      capturedUrl,
      'https://api.cerebras.ai/v1/chat/completions'
    );
    assert.equal(authorization(capturedInit), 'Bearer key-one');

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      any
    >;
    assert.equal(body['model'], 'gemma-4-31b');
    assert.equal(body['reasoning_effort'], 'none');
    assert.equal(body['stream'], false);
    assert.equal(body['max_completion_tokens'], 120);
    assert.equal(body['response_format'].type, 'json_schema');
    assert.equal(body['response_format'].json_schema.strict, true);
    assert.equal(
      body['response_format'].json_schema.schema.additionalProperties,
      false
    );
    assert.equal(
      body['response_format'].json_schema.schema.properties.segments.items
        .additionalProperties,
      false
    );
    assert.equal(
      body['response_format'].json_schema.schema.properties.segments.items
        .properties.assertions.items.additionalProperties,
      false
    );
    assert.ok(
      body['response_format'].json_schema.schema.properties.segments.items
        .properties.text.enum.includes(SAFE_CANDIDATE.segments[0]?.text)
    );
    assert.deepEqual(
      body['messages'].map((message: { role: string }) => message.role),
      ['system', 'user']
    );
    assert.match(body['messages'][0].content, /trusted_tenant_policy/u);
    assert.doesNotMatch(body['messages'][0].content, /сколько это стоит/u);
    assert.match(body['messages'][1].content, /сколько это стоит/u);
  });

  it('keeps conversations sticky while distributing calls across keys', async () => {
    const used: Array<string | null> = [];
    const runner = createRunner(async (_input, init) => {
      used.push(authorization(init));
      return completion();
    });

    for (let index = 0; index < 8; index++) {
      const conversationId = `conversation-${index}`;
      const value = request({
        turn: {
          callId: `call-${index}`,
          conversationId,
          turnId: `turn-${index}`,
          generation: 1,
        },
      });
      await runner.run(value);
      await runner.run(value);
    }

    for (let index = 0; index < used.length; index += 2) {
      assert.equal(used[index], used[index + 1]);
    }
    assert.deepEqual(new Set(used), new Set([
      'Bearer key-one',
      'Bearer key-two',
    ]));
  });

  it('puts a rate-limited key on cooldown and tries one alternate key', async () => {
    const used: Array<string | null> = [];
    let calls = 0;
    const runner = createRunner(async (_input, init) => {
      used.push(authorization(init));
      calls++;
      if (calls === 1) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '10' },
        });
      }
      return completion();
    });

    assert.deepEqual(await runner.run(request()), SAFE_CANDIDATE);
    assert.equal(used.length, 2);
    assert.notEqual(used[0], used[1]);

    await runner.run(request());
    assert.equal(used.at(-1), used[1]);
  });

  it('disables an unauthorized key and fails over without exposing it', async () => {
    const used: Array<string | null> = [];
    const runner = createRunner(async (_input, init) => {
      used.push(authorization(init));
      return used.length === 1
        ? new Response('', { status: 401 })
        : completion();
    });

    assert.deepEqual(await runner.run(request()), SAFE_CANDIDATE);
    assert.equal(used.length, 2);
    assert.notEqual(used[0], used[1]);

    await runner.run(request());
    assert.equal(used.at(-1), used[1]);
  });

  it('does not retry a non-retryable provider rejection', async () => {
    let calls = 0;
    const secret = 'secret-key-that-must-not-leak';
    const prompt = 'private caller prompt';
    const runner = createRunner(
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: `${secret} ${prompt} gemma-4-31b` }),
          { status: 400 }
        );
      },
      { apiKeys: [secret, 'other-secret'] }
    );

    await assert.rejects(
      runner.run(request({ prompt })),
      (error: unknown) => {
        assert.ok(error instanceof CerebrasVoiceModelError);
        assert.equal(error.code, 'request_failed');
        assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
        assert.doesNotMatch(error.message, new RegExp(prompt, 'u'));
        assert.doesNotMatch(error.message, /gemma-4-31b/u);
        return true;
      }
    );
    assert.equal(calls, 1);
  });

  it('filters factual and high-risk fast segments before semantic commit', async () => {
    const runner = createRunner(async () =>
      completion({
        segments: [
          {
            text: 'Стоимость составляет пятьдесят тысяч тенге.',
            assertions: [{ key: 'price', value: '50000 KZT' }],
          },
          {
            text: 'Секунду, я коротко поясню.',
            assertions: [],
          },
          {
            text: 'Встреча назначена на 15:00.',
            assertions: [],
          },
        ],
        confidence: 0.9,
        safeToCommit: true,
        requiresDeep: false,
      })
    );

    const candidate = await runner.run(request());
    assert.deepEqual(candidate.segments, [
      { text: 'Секунду, я коротко поясню.', assertions: [] },
    ]);
    assert.equal(candidate.safeToCommit, true);
  });

  it('marks a candidate unsafe when every segment is filtered', async () => {
    const runner = createRunner(async () =>
      completion({
        segments: [
          {
            text: 'Цена — 1000 тенге.',
            assertions: [],
          },
        ],
        confidence: 0.9,
        safeToCommit: true,
        requiresDeep: false,
      })
    );

    const candidate = await runner.run(request());
    assert.deepEqual(candidate.segments, []);
    assert.equal(candidate.safeToCommit, false);
  });

  it('blocks spelled-out Russian and Kazakh factual claims', async () => {
    const runner = createRunner(async () =>
      completion({
        segments: [
          {
            text: 'Стоимость зависит от тарифа.',
            assertions: [],
          },
          {
            text: 'Бағасы елу мың теңге.',
            assertions: [],
          },
          {
            text: 'Хороший вопрос, сейчас коротко поясню.',
            assertions: [],
          },
        ],
        confidence: 0.9,
        safeToCommit: true,
        requiresDeep: false,
      })
    );

    const candidate = await runner.run(request());
    assert.deepEqual(candidate.segments, [
      {
        text: 'Хороший вопрос, сейчас коротко поясню.',
        assertions: [],
      },
    ]);
    assert.equal(candidate.safeToCommit, true);
  });

  it('fails closed for an unlisted factual sentence without assertions', async () => {
    const runner = createRunner(async () =>
      completion({
        segments: [
          {
            text: 'Наш офис находится на улице Абая.',
            assertions: [],
          },
        ],
        confidence: 0.99,
        safeToCommit: true,
        requiresDeep: false,
      })
    );

    const candidate = await runner.run(request());
    assert.deepEqual(candidate.segments, []);
    assert.equal(candidate.safeToCommit, false);
  });

  it('rejects incomplete structured output without trying another key', async () => {
    let calls = 0;
    const runner = createRunner(async () => {
      calls++;
      return completion(SAFE_CANDIDATE, 'length');
    });

    await assert.rejects(
      runner.run(request()),
      (error: unknown) =>
        error instanceof CerebrasVoiceModelError &&
        error.code === 'invalid_response'
    );
    assert.equal(calls, 1);
  });

  it('honors cancellation before issuing a provider request', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const runner = createRunner(async () => {
      calls++;
      return completion();
    });

    await assert.rejects(
      runner.run(request({ signal: controller.signal })),
      (error: unknown) =>
        error instanceof CerebrasVoiceModelError &&
        error.code === 'cancelled'
    );
    assert.equal(calls, 0);
  });

  it('enforces the absolute deadline with an abortable request', async () => {
    const runner = createRunner(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        }),
      {
        apiKeys: ['deadline-key'],
        maxAttempts: 1,
        now: Date.now,
      }
    );

    await assert.rejects(
      runner.run(request({ deadlineAtMs: Date.now() + 20 })),
      (error: unknown) =>
        error instanceof CerebrasVoiceModelError &&
        error.code === 'deadline_exceeded'
    );
  });

  it('keeps the deadline active while reading the response body', async () => {
    const runner = createRunner(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Headers arrive, but the provider never sends a body chunk.
            },
          }),
          { status: 200 }
        ),
      {
        apiKeys: ['slow-body-key'],
        maxAttempts: 1,
        now: Date.now,
      }
    );

    await assert.rejects(
      runner.run(request({ deadlineAtMs: Date.now() + 20 })),
      (error: unknown) =>
        error instanceof CerebrasVoiceModelError &&
        error.code === 'deadline_exceeded'
    );
  });
});
