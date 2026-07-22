import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CerebrasTextChatClient,
  TextChatProviderError,
} from '../../src/chat/cerebras-client';

const request = {
  conversationId: 'conversation-1',
  systemPrompt: 'Ты — менеджер магазина.',
  messages: [{ role: 'user' as const, content: 'Сколько стоит доставка?' }],
  temperature: 0.4,
  maxTokens: 512,
};

function successfulResponse(text = 'Доставка стоит 1 500 тенге.'): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: text },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Cerebras text chat client', () => {
  it('sends bounded chat history and returns a complete assistant reply', async () => {
    let body: Record<string, unknown> | undefined;
    const client = new CerebrasTextChatClient({
      apiKeys: ['test-key'],
      model: 'gemma-4-31b',
      timeoutMs: 1_000,
      now: () => 1_000,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer test-key'
        );
        return successfulResponse();
      },
    });

    const reply = await client.reply(request);

    assert.equal(reply.text, 'Доставка стоит 1 500 тенге.');
    assert.equal(reply.tokensInput, 12);
    assert.equal(reply.tokensOutput, 7);
    assert.equal(body?.['model'], 'gemma-4-31b');
    assert.equal(body?.['stream'], false);
    assert.equal(body?.['reasoning_effort'], 'none');
    assert.deepEqual(body?.['messages'], [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.messages[0]!.content },
    ]);
  });

  it('puts a rate-limited key on cooldown and tries one alternate key', async () => {
    const authorizations: string[] = [];
    const client = new CerebrasTextChatClient({
      apiKeys: ['key-one', 'key-two'],
      model: 'gemma-4-31b',
      timeoutMs: 1_000,
      now: () => 2_000,
      fetch: async (_input, init) => {
        authorizations.push(
          new Headers(init?.headers).get('Authorization') ?? ''
        );
        return authorizations.length === 1
          ? new Response('', {
              status: 429,
              headers: { 'retry-after': '1' },
            })
          : successfulResponse('Ответ со второго ключа.');
      },
    });

    const reply = await client.reply(request);

    assert.equal(reply.text, 'Ответ со второго ключа.');
    assert.equal(authorizations.length, 2);
    assert.notEqual(authorizations[0], authorizations[1]);
  });

  it('rejects configuration and malformed provider responses safely', async () => {
    assert.throws(
      () => new CerebrasTextChatClient({
        apiKeys: [],
        model: 'gemma-4-31b',
        timeoutMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof TextChatProviderError &&
        error.code === 'configuration'
    );

    const rawProviderBody = 'private-provider-body-with-secret';
    const client = new CerebrasTextChatClient({
      apiKeys: ['test-key'],
      model: 'gemma-4-31b',
      timeoutMs: 1_000,
      fetch: async () => new Response(rawProviderBody, { status: 200 }),
    });

    await assert.rejects(
      () => client.reply(request),
      (error: unknown) => {
        assert.equal(String(error).includes(rawProviderBody), false);
        return (
          error instanceof TextChatProviderError &&
          error.code === 'invalid_response'
        );
      }
    );
  });
});
