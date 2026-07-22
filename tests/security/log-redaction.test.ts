import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import winston from 'winston';
import { logger, sanitizeLogMetadata } from '../../src/utils/logger';

test('log metadata redacts OAuth, provider credentials, PII and raw errors', () => {
  const providerError = new Error('Bearer access-token-that-must-not-leak');
  Object.assign(providerError, {
    config: {
      headers: { Authorization: 'Bearer provider-access-token' },
      data: {
        client_secret: 'crm-client-secret',
        refresh_token: 'crm-refresh-token',
      },
    },
  });

  const sanitized = sanitizeLogMetadata({
    error: providerError,
    rawText: 'private customer transcript',
    phone: '+77001234567',
    nested: {
      authorization: 'Bearer nested-token',
      database: 'postgresql://user:password@private.example/db',
      provider: 'csk-super-secret-provider-key',
    },
    safeCode: 'ECONNRESET',
  });
  const output = JSON.stringify(sanitized);

  for (const secret of [
    'access-token-that-must-not-leak',
    'provider-access-token',
    'crm-client-secret',
    'crm-refresh-token',
    'private customer transcript',
    '+77001234567',
    'password@private.example',
    'csk-super-secret-provider-key',
  ]) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(sanitized.safeCode, 'ECONNRESET');
});

test('final logger output redacts direct Errors and contact identifiers', async () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  const transport = new winston.transports.Stream({ stream });
  logger.add(transport);
  try {
    logger.error(new Error('private direct error text'));
    logger.info('Safe event', {
      callerId: '+77001234567',
      chatId: 'telegram-private-chat',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    logger.remove(transport);
  }

  assert.doesNotMatch(output, /private direct error text/u);
  assert.doesNotMatch(output, /\+77001234567/u);
  assert.doesNotMatch(output, /telegram-private-chat/u);
  assert.match(output, /RedactedError/u);
});
