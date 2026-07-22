import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('webchat migration tracks a dedicated channel and unique tenant session', async () => {
  const migration = await readFile(
    path.resolve('migrations/006_webchat_channel.sql'),
    'utf8'
  );

  assert.match(
    migration,
    /ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'webchat'/
  );
  assert.match(
    migration,
    /ON conversations\(org_id, external_id\)/
  );
  assert.match(migration, /external_id LIKE 'webchat:%'/);
  assert.match(migration, /array_append\(channels, 'webchat'\)/);
});
