import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import {
  parseConfigEnvironment,
  resolveVoiceFastTimeoutMs,
} from '../../src/config';

const BASE_ENV: NodeJS.ProcessEnv = Object.freeze({
  NODE_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  ANTHROPIC_API_KEY: 'anthropic-test-key',
  GOOGLE_API_KEY: 'google-test-key',
});

const PIPELINE_ENV: NodeJS.ProcessEnv = Object.freeze({
  ...BASE_ENV,
  VOICE_RUNTIME: 'pipeline',
  DEEPGRAM_API_KEY: 'deepgram-test-key',
  FISH_API_KEY: 'fish-test-key',
  FISH_TTS_REFERENCE_ID: 'fish-test-reference',
  VOICE_DEFAULT_ORG_ID: '11111111-1111-4111-8111-111111111111',
  VOICE_WS_AUTH_TOKEN: 'voice-test-token-at-least-32-characters',
});

describe('voice LLM environment configuration', () => {
  it('keeps Anthropic as the default and exposes Cerebras defaults', () => {
    const parsed = parseConfigEnvironment(BASE_ENV);

    assert.equal(parsed.VOICE_LLM_FAST_PROVIDER, 'anthropic');
    assert.equal(parsed.GEMINI_EMBED_MODEL, 'gemini-embedding-2');
    assert.equal(parsed.VOICE_LLM_CEREBRAS_MODEL, 'gemma-4-31b');
    assert.equal(parsed.VOICE_LLM_FAST_TIMEOUT_MS, 600);
    assert.equal(parsed.VOICE_LLM_CEREBRAS_FAST_TIMEOUT_MS, 3000);
    assert.equal(parsed.CEREBRAS_API_KEYS, undefined);
    assert.equal(parsed.TEXT_CHAT_ENABLED, false);
    assert.equal(parsed.TEXT_CHAT_CEREBRAS_MODEL, 'gemma-4-31b');
    assert.equal(parsed.TEXT_CHAT_CLASSIFICATION_ENABLED, false);
    assert.equal(parsed.TEXT_CHAT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
    assert.equal(resolveVoiceFastTimeoutMs(parsed), 600);
  });

  it('requires Cerebras keys when automatic text chat is enabled', () => {
    assert.throws(
      () =>
        parseConfigEnvironment({
          ...BASE_ENV,
          TEXT_CHAT_ENABLED: 'true',
        }),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some(
          issue => issue.path.join('.') === 'CEREBRAS_API_KEYS'
        )
    );

    const parsed = parseConfigEnvironment({
      ...BASE_ENV,
      TEXT_CHAT_ENABLED: 'true',
      CEREBRAS_API_KEYS: 'text-chat-test-key',
    });
    assert.equal(parsed.TEXT_CHAT_ENABLED, true);
  });

  it('normalizes and de-duplicates a Cerebras key pool', () => {
    const parsed = parseConfigEnvironment({
      ...PIPELINE_ENV,
      VOICE_LLM_FAST_PROVIDER: 'cerebras',
      CEREBRAS_API_KEYS: ' first-test-key,second-test-key, first-test-key ',
    });

    assert.deepEqual(parsed.CEREBRAS_API_KEYS, [
      'first-test-key',
      'second-test-key',
    ]);
    assert.equal(Object.isFrozen(parsed.CEREBRAS_API_KEYS), true);
    assert.equal(resolveVoiceFastTimeoutMs(parsed), 3000);
  });

  it('requires Cerebras keys only when the pipeline selects Cerebras', () => {
    assert.doesNotThrow(() => parseConfigEnvironment(PIPELINE_ENV));

    assert.throws(
      () =>
        parseConfigEnvironment({
          ...PIPELINE_ENV,
          VOICE_LLM_FAST_PROVIDER: 'cerebras',
        }),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some(
          issue => issue.path.join('.') === 'CEREBRAS_API_KEYS'
        )
    );
  });

  it('rejects empty entries inside the Cerebras key pool', () => {
    assert.throws(
      () =>
        parseConfigEnvironment({
          ...BASE_ENV,
          CEREBRAS_API_KEYS: 'first-test-key,,second-test-key',
        }),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some(
          issue => issue.path.join('.') === 'CEREBRAS_API_KEYS'
        )
    );
  });

  it('rejects the retired embedding model instead of mixing vector spaces', () => {
    assert.throws(
      () =>
        parseConfigEnvironment({
          ...BASE_ENV,
          GEMINI_EMBED_MODEL: 'text-embedding-004',
        }),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some(
          issue => issue.path.join('.') === 'GEMINI_EMBED_MODEL'
        )
    );
  });
});
