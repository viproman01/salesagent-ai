import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TextChatProviderError } from '../../src/chat/cerebras-client';
import { GeminiTextChatClient } from '../../src/chat/gemini-client';

const request = {
  conversationId: 'conversation-1',
  systemPrompt: 'Ты — менеджер.',
  messages: [
    { role: 'user' as const, content: 'Здравствуйте' },
    { role: 'assistant' as const, content: 'Добрый день!' },
    { role: 'user' as const, content: 'Есть доставка?' },
  ],
  temperature: 0.3,
  maxTokens: 256,
};

describe('Gemini text chat fallback', () => {
  it('maps chat roles and parses a complete response', async () => {
    let body: Record<string, unknown> | undefined;
    const client = new GeminiTextChatClient({
      apiKey: 'google-test-key',
      model: 'gemini-3.5-flash-lite',
      timeoutMs: 1_000,
      now: () => 5_000,
      fetch: async (input, init) => {
        assert.match(String(input), /gemini-3\.5-flash-lite:generateContent$/);
        assert.equal(
          new Headers(init?.headers).get('x-goog-api-key'),
          'google-test-key'
        );
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'Да, доставка доступна.' }] },
          }],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 6,
          },
        }), { status: 200 });
      },
    });

    const reply = await client.reply(request);

    assert.equal(reply.text, 'Да, доставка доступна.');
    assert.equal(reply.tokensInput, 15);
    assert.equal(reply.tokensOutput, 6);
    assert.deepEqual(body?.['contents'], [
      { role: 'user', parts: [{ text: 'Здравствуйте' }] },
      { role: 'model', parts: [{ text: 'Добрый день!' }] },
      { role: 'user', parts: [{ text: 'Есть доставка?' }] },
    ]);
  });

  it('maps provider failures without exposing response bodies', async () => {
    const client = new GeminiTextChatClient({
      apiKey: 'google-test-key',
      model: 'gemini-3.5-flash-lite',
      timeoutMs: 1_000,
      fetch: async () => new Response('private-google-error', { status: 429 }),
    });

    await assert.rejects(
      () => client.reply(request),
      (error: unknown) => {
        assert.equal(String(error).includes('private-google-error'), false);
        return (
          error instanceof TextChatProviderError &&
          error.code === 'rate_limited'
        );
      }
    );
  });
});
