-- ============================================================
-- Migration 001: Начальная схема — организации, пользователи,
--                агенты, лиды, разговоры, сообщения
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Организации (мультитенантный корень)
-- ============================================================
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  plan          VARCHAR(50)  NOT NULL DEFAULT 'trial',
  max_agents    INTEGER NOT NULL DEFAULT 1,
  max_leads     INTEGER NOT NULL DEFAULT 500,
  max_minutes   INTEGER NOT NULL DEFAULT 100,
  max_messages  INTEGER NOT NULL DEFAULT 1000,
  timezone      VARCHAR(50)  NOT NULL DEFAULT 'Asia/Almaty',
  country       VARCHAR(2)   NOT NULL DEFAULT 'KZ',
  currency      VARCHAR(3)   NOT NULL DEFAULT 'KZT',
  metadata      JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Пользователи (администраторы организаций)
-- ============================================================
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(255) NOT NULL,
  role            VARCHAR(50)  NOT NULL DEFAULT 'admin',
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_org_id ON users(org_id);
CREATE INDEX idx_users_email  ON users(email);

-- ============================================================
-- Агенты (AI-персонажи)
-- ============================================================
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  system_prompt   TEXT NOT NULL,
  persona         JSONB NOT NULL DEFAULT '{}',
  channels        TEXT[] NOT NULL DEFAULT '{}',
  voice_config    JSONB NOT NULL DEFAULT '{"voice":"Aoede","language":"ru-RU","speed":1.0}',
  model_text      VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  model_voice     VARCHAR(100) NOT NULL DEFAULT 'gemini-3.1-flash-live-preview',
  temperature     NUMERIC(3,2) NOT NULL DEFAULT 0.7,
  max_tokens      INTEGER      NOT NULL DEFAULT 1024,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agents_org_id ON agents(org_id);

-- ============================================================
-- Лиды
-- ============================================================
CREATE TYPE lead_stage AS ENUM (
  'new','contacted','interested','objection',
  'negotiation','meeting_booked','closed_won','closed_lost','nurturing'
);

CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone           VARCHAR(30) NOT NULL,
  name            VARCHAR(255),
  email           VARCHAR(255),
  stage           lead_stage   NOT NULL DEFAULT 'new',
  score           INTEGER      NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  source          VARCHAR(100) NOT NULL DEFAULT 'unknown',
  external_crm_id VARCHAR(255),
  crm_type        VARCHAR(50),
  metadata        JSONB        NOT NULL DEFAULT '{}',
  last_contact_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_leads_org_phone ON leads(org_id, phone);
CREATE INDEX idx_leads_org_stage        ON leads(org_id, stage);
CREATE INDEX idx_leads_org_score        ON leads(org_id, score DESC);
CREATE INDEX idx_leads_org_created      ON leads(org_id, created_at DESC);

-- ============================================================
-- Разговоры
-- ============================================================
CREATE TYPE channel_type AS ENUM ('whatsapp', 'telegram', 'voice');
CREATE TYPE conversation_status AS ENUM ('active', 'completed', 'failed', 'timeout');

CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           UUID REFERENCES leads(id) ON DELETE SET NULL,
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  channel           channel_type        NOT NULL,
  status            conversation_status NOT NULL DEFAULT 'active',
  classification    JSONB,
  summary           TEXT,
  sentiment         VARCHAR(20),
  quality_score     NUMERIC(3,2),
  message_count     INTEGER      NOT NULL DEFAULT 0,
  duration_seconds  INTEGER,
  external_id       VARCHAR(255),
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  last_message_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_org_id      ON conversations(org_id);
CREATE INDEX idx_conversations_lead_id     ON conversations(lead_id);
CREATE INDEX idx_conversations_org_channel ON conversations(org_id, channel);
CREATE INDEX idx_conversations_org_status  ON conversations(org_id, status);
CREATE INDEX idx_conversations_created     ON conversations(org_id, created_at DESC);
CREATE INDEX idx_conversations_conv_time   ON conversations(id, created_at DESC);

-- ============================================================
-- Сообщения
-- ============================================================
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'tool', 'system');

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             message_role NOT NULL,
  content          TEXT,
  tool_name        VARCHAR(100),
  tool_input       JSONB,
  tool_result      JSONB,
  tokens_input     INTEGER,
  tokens_output    INTEGER,
  latency_ms       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- ============================================================
-- Триггеры
-- ============================================================
CREATE OR REPLACE FUNCTION update_conversation_stats()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET message_count   = message_count + 1,
      last_message_at = NEW.created_at,
      updated_at      = NOW()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_message_inserted
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION update_conversation_stats();

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orgs_updated   BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated  BEFORE UPDATE ON users          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_agents_updated BEFORE UPDATE ON agents         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_leads_updated  BEFORE UPDATE ON leads          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_conv_updated   BEFORE UPDATE ON conversations  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
