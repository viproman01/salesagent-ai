import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('migration invalidates untracked vectors and filters by embedding model', async () => {
  const sql = await readFile(
    path.join(process.cwd(), 'migrations/005_embedding_model.sql'),
    'utf8'
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS embedding_model TEXT/u);
  assert.match(sql, /SET embedding = NULL,[\s\S]*embedding_model = NULL/u);
  assert.match(
    sql,
    /embedding_model IS DISTINCT FROM 'gemini-embedding-2'/u
  );
  assert.match(
    sql,
    /CREATE FUNCTION match_knowledge\([\s\S]*filter_embedding_model TEXT[\s\S]*threshold\s+DOUBLE PRECISION/u
  );
  assert.match(sql, /chunk\.embedding_model = filter_embedding_model/u);
});

test('runtime search and ingestion pass the configured embedding model', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/rag/search.ts'),
    'utf8'
  );

  assert.match(
    source,
    /match_knowledge\(\$1::vector, \$2, \$3, \$4, \$5\)/u
  );
  assert.match(
    source,
    /\[embeddingStr, topK, orgId, config\.GEMINI_EMBED_MODEL, threshold\]/u
  );
  assert.match(
    source,
    /\(org_id, content, embedding, embedding_model,[\s\S]*config\.GEMINI_EMBED_MODEL/u
  );
});
