-- ============================================================
-- Migration 003: Аналитика и ежедневные метрики
-- ============================================================

CREATE TABLE daily_metrics (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date                  DATE NOT NULL,
  -- Разговоры
  total_conversations   INTEGER NOT NULL DEFAULT 0,
  voice_conversations   INTEGER NOT NULL DEFAULT 0,
  whatsapp_conversations INTEGER NOT NULL DEFAULT 0,
  telegram_conversations INTEGER NOT NULL DEFAULT 0,
  -- Лиды
  leads_created         INTEGER NOT NULL DEFAULT 0,
  leads_converted       INTEGER NOT NULL DEFAULT 0,
  -- Производительность
  avg_response_time_ms  INTEGER NOT NULL DEFAULT 0,
  avg_conversation_duration_sec INTEGER NOT NULL DEFAULT 0,
  -- Топ возражений: [{"text":"дорого","count":5}, ...]
  top_objections        JSONB NOT NULL DEFAULT '[]',
  -- Использование токенов
  tokens_input_total    BIGINT NOT NULL DEFAULT 0,
  tokens_output_total   BIGINT NOT NULL DEFAULT 0,
  -- Пересчитывается каждый день
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, date)
);

CREATE INDEX idx_daily_metrics_org_date ON daily_metrics(org_id, date DESC);

CREATE TRIGGER trg_metrics_updated
  BEFORE UPDATE ON daily_metrics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- CRM-подключения (AmoCRM и др.)
-- ============================================================
CREATE TABLE crm_connections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crm_type         VARCHAR(50) NOT NULL DEFAULT 'amocrm',
  domain           VARCHAR(255) NOT NULL,
  access_token     TEXT,
  refresh_token    TEXT,
  token_expires_at TIMESTAMPTZ,
  pipeline_id      VARCHAR(100),
  -- Маппинг этапов воронки: {"new": "12345", "interested": "12346", ...}
  stage_mapping    JSONB NOT NULL DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  last_sync_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, crm_type)
);

CREATE INDEX idx_crm_connections_org ON crm_connections(org_id);

CREATE TRIGGER trg_crm_updated
  BEFORE UPDATE ON crm_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
