-- ============================================================
-- Migration 005: model-safe RAG embeddings
-- ============================================================

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Rows created before model tracking cannot be identified safely. Clearing
-- those vectors prevents cosine comparisons across incompatible models. The
-- reindex command restores them with the configured model after deployment.
UPDATE knowledge_chunks
SET embedding = NULL,
    embedding_model = NULL
WHERE embedding IS NOT NULL
  AND embedding_model IS DISTINCT FROM 'gemini-embedding-2';

UPDATE knowledge_chunks
SET embedding_model = NULL
WHERE embedding IS NULL
  AND embedding_model IS NOT NULL;

ALTER TABLE knowledge_chunks
  DROP CONSTRAINT IF EXISTS knowledge_chunks_embedding_model_consistency;

ALTER TABLE knowledge_chunks
  ADD CONSTRAINT knowledge_chunks_embedding_model_consistency
  CHECK (
    (embedding IS NULL AND embedding_model IS NULL)
    OR (
      embedding IS NOT NULL
      AND embedding_model IS NOT NULL
      AND btrim(embedding_model) <> ''
    )
  );

CREATE INDEX IF NOT EXISTS idx_knowledge_org_embedding_model
  ON knowledge_chunks(org_id, embedding_model)
  WHERE embedding IS NOT NULL;

DROP FUNCTION IF EXISTS match_knowledge(
  vector,
  INTEGER,
  UUID,
  DOUBLE PRECISION
);

DROP FUNCTION IF EXISTS match_knowledge(
  vector,
  INTEGER,
  UUID,
  TEXT,
  DOUBLE PRECISION
);

CREATE FUNCTION match_knowledge(
  query_embedding        vector(768),
  match_count            INTEGER,
  filter_org_id          UUID,
  filter_embedding_model TEXT,
  threshold              DOUBLE PRECISION DEFAULT 0.7
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  category    VARCHAR(100),
  source_file VARCHAR(500),
  similarity  DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    chunk.id,
    chunk.content,
    chunk.category,
    chunk.source_file,
    1 - (chunk.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks AS chunk
  WHERE chunk.org_id = filter_org_id
    AND chunk.embedding IS NOT NULL
    AND chunk.embedding_model = filter_embedding_model
    AND 1 - (chunk.embedding <=> query_embedding) >= threshold
  ORDER BY chunk.embedding <=> query_embedding
  LIMIT match_count;
$$;
