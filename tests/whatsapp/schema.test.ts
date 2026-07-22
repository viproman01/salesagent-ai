import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('WhatsApp receipts deduplicate per tenant without storing message content', async () => {
  const migration = await readFile(
    path.resolve('migrations/007_whatsapp_inbound_receipts.sql'),
    'utf8'
  );

  assert.match(migration, /UNIQUE \(org_id, message_id\)/);
  assert.match(migration, /status IN \('processing', 'processed', 'failed'\)/);
  assert.doesNotMatch(migration, /\bcontent\b/i);
  assert.doesNotMatch(migration, /\bauth\b/i);
});
