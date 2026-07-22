import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseConfigEnvironment } from '../../src/config';

const BASE_ENV: NodeJS.ProcessEnv = Object.freeze({
  NODE_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  ANTHROPIC_API_KEY: 'anthropic-test-key',
  GOOGLE_API_KEY: 'google-test-key',
});

describe('WhatsApp bridge configuration', () => {
  it('uses safe pilot defaults without Wazzup credentials', () => {
    const parsed = parseConfigEnvironment(BASE_ENV);
    assert.equal(parsed.WHATSAPP_AUTH_DIR, './data/whatsapp-auth');
    assert.equal(parsed.WHATSAPP_AUTO_START, true);
    assert.equal(parsed.WHATSAPP_RECONNECT_BASE_DELAY_MS, 1000);
    assert.equal(parsed.WHATSAPP_RECONNECT_MAX_DELAY_MS, 30000);
    assert.equal(parsed.WHATSAPP_INBOUND_MAX_CHARS, 4096);
    assert.equal(parsed.WHATSAPP_OUTBOUND_MAX_CHARS, 4096);
    assert.equal(parsed.WHATSAPP_INBOUND_RATE_WINDOW_MS, 60000);
    assert.equal(parsed.WHATSAPP_INBOUND_RATE_MAX_MESSAGES, 12);
    assert.equal(parsed.WHATSAPP_INBOUND_ORG_RATE_MAX_MESSAGES, 240);
    assert.equal('WAZZUP24_API_KEY' in parsed, false);
  });

  it('rejects a maximum reconnect delay below the base delay', () => {
    assert.throws(
      () => parseConfigEnvironment({
        ...BASE_ENV,
        WHATSAPP_RECONNECT_BASE_DELAY_MS: '5000',
        WHATSAPP_RECONNECT_MAX_DELAY_MS: '1000',
      }),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some(
          issue => issue.path.join('.') === 'WHATSAPP_RECONNECT_MAX_DELAY_MS'
        )
    );
  });
});
