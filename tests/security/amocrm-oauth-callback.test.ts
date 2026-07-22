import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('disabled AmoCRM callback never reads or echoes an OAuth code', async () => {
  const source = await readFile(path.resolve('src/index.ts'), 'utf8');
  const start = source.indexOf("app.get('/api/crm/amocrm/callback'");
  const end = source.indexOf('// ---- Обработка ошибок ----', start);
  assert.ok(start >= 0 && end > start);
  const callback = source.slice(start, end);

  assert.doesNotMatch(callback, /req\.query/u);
  assert.doesNotMatch(callback, /\bcode\b\s*:/u);
  assert.match(callback, /status\(404\)/u);
  assert.match(callback, /Cache-Control/u);
});
