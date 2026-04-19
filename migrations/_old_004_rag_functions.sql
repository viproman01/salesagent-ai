-- ============================================================
-- Migration 004: Функции RAG — векторный и гибридный поиск
-- ============================================================

-- ============================================================
-- Функция: match_knowledge
-- Семантический поиск по базе знаний через косинусное сходство
-- Используется агентом для поиска релевантного контента
-- ============================================================
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding    vector(768),
  organization_id    UUID,
  match_threshold    FLOAT DEFAULT 0.7,
  match_count        INT DEFAULT 5,
  filter_agent_id    UUID DEFAULT NULL,
  filter_category    TEXT DEFAULT NULL
)
RETURNS TABLE (
  id          UUID,
  title       TEXT,
  content     TEXT,
  category    TEXT,
  source_name TEXT,
  similarity  FLOAT,
  metadata    JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.title,
    kc.content,
    kc.category,
    kc.source_name,
    1 - (kc.embedding <=> query_embedding) AS similarity,
    kc.metadata
  FROM knowledge_chunks kc
  WHERE
    kc.organization_id = match_knowledge.organization_id
    AND kc.is_active = TRUE
    AND kc.embedding IS NOT NULL
    -- Фильтрация по агенту (если указан)
    AND (filter_agent_id IS NULL OR kc.agent_id = filter_agent_id OR kc.agent_id IS NULL)
    -- Фильтрация по категории (если указана)
    AND (filter_category IS NULL OR kc.category = filter_category)
    -- Порог сходства
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding  -- ASC — ближайшие сначала
  LIMIT match_count;
END;
$$;

-- ============================================================
-- Функция: hybrid_search_knowledge
-- Гибридный поиск: векторный + полнотекстовый (BM25-like)
-- Использует RRF (Reciprocal Rank Fusion) для объединения
-- ============================================================
CREATE OR REPLACE FUNCTION hybrid_search_knowledge(
  query_text         TEXT,
  query_embedding    vector(768),
  organization_id    UUID,
  match_count        INT DEFAULT 5,
  vector_weight      FLOAT DEFAULT 0.7,
  text_weight        FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id          UUID,
  title       TEXT,
  content     TEXT,
  category    TEXT,
  source_name TEXT,
  score       FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH
  -- Векторный поиск
  vector_results AS (
    SELECT
      kc.id,
      ROW_NUMBER() OVER (ORDER BY kc.embedding <=> query_embedding) AS rank,
      1 - (kc.embedding <=> query_embedding) AS vector_score
    FROM knowledge_chunks kc
    WHERE kc.organization_id = hybrid_search_knowledge.organization_id
      AND kc.is_active = TRUE
      AND kc.embedding IS NOT NULL
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  -- Полнотекстовый поиск
  text_results AS (
    SELECT
      kc.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
        to_tsvector('russian', COALESCE(kc.title, '') || ' ' || kc.content),
        plainto_tsquery('russian', query_text)
      ) DESC) AS rank,
      ts_rank_cd(
        to_tsvector('russian', COALESCE(kc.title, '') || ' ' || kc.content),
        plainto_tsquery('russian', query_text)
      ) AS text_score
    FROM knowledge_chunks kc
    WHERE kc.organization_id = hybrid_search_knowledge.organization_id
      AND kc.is_active = TRUE
      AND to_tsvector('russian', COALESCE(kc.title, '') || ' ' || kc.content)
          @@ plainto_tsquery('russian', query_text)
    ORDER BY text_score DESC
    LIMIT match_count * 2
  ),
  -- RRF (Reciprocal Rank Fusion)
  combined AS (
    SELECT
      COALESCE(vr.id, tr.id) AS id,
      (
        COALESCE(vector_weight / (60.0 + vr.rank), 0) +
        COALESCE(text_weight / (60.0 + tr.rank), 0)
      ) AS rrf_score
    FROM vector_results vr
    FULL OUTER JOIN text_results tr ON vr.id = tr.id
  )
  SELECT
    kc.id,
    kc.title,
    kc.content,
    kc.category,
    kc.source_name,
    c.rrf_score AS score
  FROM combined c
  JOIN knowledge_chunks kc ON kc.id = c.id
  ORDER BY c.rrf_score DESC
  LIMIT match_count;
END;
$$;

-- ============================================================
-- Функция: get_conversation_context
-- Возвращает последние N сообщений диалога для контекста LLM
-- ============================================================
CREATE OR REPLACE FUNCTION get_conversation_context(
  p_conversation_id UUID,
  p_limit           INT DEFAULT 20
)
RETURNS TABLE (
  role      TEXT,
  content   TEXT,
  tool_name TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.role::TEXT,
    m.content,
    m.tool_name,
    m.created_at
  FROM messages m
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at DESC
  LIMIT p_limit;
END;
$$;
