-- ============================================================
-- Migration 002: База знаний с pgvector + записи звонков
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Чанки базы знаний (RAG)
-- ============================================================
CREATE TABLE knowledge_chunks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  embedding    vector(768),
  category     VARCHAR(100),
  source_file  VARCHAR(500),
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  token_count  INTEGER,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IVFFlat индекс для быстрого поиска по косинусному сходству
CREATE INDEX idx_knowledge_org_id ON knowledge_chunks(org_id);
CREATE INDEX idx_knowledge_embedding
  ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- Функция поиска по знаниям (cosine similarity)
-- ============================================================
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding  vector(768),
  match_count      INTEGER,
  filter_org_id    UUID,
  threshold        FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  category    VARCHAR(100),
  source_file VARCHAR(500),
  similarity  FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id,
    k.content,
    k.category,
    k.source_file,
    1 - (k.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks k
  WHERE
    k.org_id = filter_org_id
    AND k.embedding IS NOT NULL
    AND 1 - (k.embedding <=> query_embedding) >= threshold
  ORDER BY k.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Записи звонков
-- ============================================================
CREATE TABLE call_recordings (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  s3_key           VARCHAR(500) NOT NULL,
  duration_seconds INTEGER,
  transcript       TEXT,
  -- Маркеры: [{time_ms, type: 'objection'|'agreement'|'pricing', text}]
  highlights       JSONB NOT NULL DEFAULT '[]',
  quality_score    NUMERIC(3,2),
  file_size_bytes  BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recordings_conversation ON call_recordings(conversation_id);
