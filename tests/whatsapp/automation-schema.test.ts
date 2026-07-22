import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('WhatsApp automation migration persists handoff, attribution and outbox state', async () => {
  const migration = await readFile(
    path.resolve('migrations/008_whatsapp_automation_outbox.sql'),
    'utf8'
  );

  assert.match(migration, /reply_mode[\s\S]*'ai'[\s\S]*'operator'/);
  assert.match(migration, /mode_version/);
  assert.match(migration, /sender_type/);
  assert.match(migration, /delivery_status/);
  assert.match(migration, /sequence_id BIGSERIAL/);
  assert.match(migration, /ALTER COLUMN sequence_id SET NOT NULL/);
  assert.match(migration, /CREATE TABLE whatsapp_outbox/);
  assert.match(migration, /UNIQUE \(org_id, idempotency_key\)/);
  assert.match(migration, /provider_message_id/);
  assert.doesNotMatch(migration, /devicePairingData|eIdent|eSkeyVal|eSkeySig/);
});
