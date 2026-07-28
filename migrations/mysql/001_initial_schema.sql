CREATE TABLE IF NOT EXISTS organizations (
  id CHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(100) NOT NULL UNIQUE,
  plan VARCHAR(50) NOT NULL DEFAULT 'trial', max_agents INT NOT NULL DEFAULT 1,
  max_leads INT NOT NULL DEFAULT 500, max_minutes INT NOT NULL DEFAULT 100,
  max_messages INT NOT NULL DEFAULT 1000, timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Almaty',
  country CHAR(2) NOT NULL DEFAULT 'KZ', currency CHAR(3) NOT NULL DEFAULT 'KZT',
  metadata JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE, last_login_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE, INDEX idx_users_org (org_id)
);
CREATE TABLE IF NOT EXISTS agents (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, name VARCHAR(100) NOT NULL, system_prompt TEXT NOT NULL,
  persona JSON NULL, channels JSON NOT NULL, voice_config JSON NOT NULL, model_text VARCHAR(200) NOT NULL,
  model_voice VARCHAR(100) NOT NULL DEFAULT 's2.1-pro-free', temperature DECIMAL(3,2) NOT NULL DEFAULT 0.70,
  max_tokens INT NOT NULL DEFAULT 1024, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_agents_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE, INDEX idx_agents_org (org_id)
);
CREATE TABLE IF NOT EXISTS leads (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, phone VARCHAR(30) NOT NULL, name VARCHAR(255) NULL,
  email VARCHAR(255) NULL, stage VARCHAR(50) NOT NULL DEFAULT 'new', score INT NOT NULL DEFAULT 0,
  source VARCHAR(100) NOT NULL DEFAULT 'unknown', external_crm_id VARCHAR(255) NULL, crm_type VARCHAR(50) NULL,
  notes TEXT NULL, tags JSON NULL, deal_amount BIGINT NULL, next_contact_at TIMESTAMP NULL, metadata JSON NULL,
  last_contact_at TIMESTAMP NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_leads_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_leads_org_phone (org_id, phone), INDEX idx_leads_org_stage (org_id, stage)
);
CREATE TABLE IF NOT EXISTS conversations (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, lead_id CHAR(36) NULL, agent_id CHAR(36) NULL,
  channel VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', classification JSON NULL,
  metadata JSON NULL, summary TEXT NULL, sentiment VARCHAR(20) NULL, quality_score DECIMAL(5,2) NULL,
  message_count INT NOT NULL DEFAULT 0, duration_seconds INT NULL, external_id VARCHAR(255) NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TIMESTAMP NULL, last_message_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_conversations_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_conversations_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_conversations_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  INDEX idx_conversations_org_status (org_id, status), INDEX idx_conversations_lead (lead_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id CHAR(36) PRIMARY KEY, conversation_id CHAR(36) NOT NULL, role VARCHAR(20) NOT NULL, content TEXT NULL,
  tool_name VARCHAR(100) NULL, tool_input JSON NULL, tool_result JSON NULL, tokens_input INT NULL,
  tokens_output INT NULL, latency_ms INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_messages_conversation_time (conversation_id, created_at)
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, content TEXT NOT NULL, embedding JSON NULL,
  category VARCHAR(100) NULL, source_file VARCHAR(500) NULL, chunk_index INT NOT NULL DEFAULT 0,
  token_count INT NULL, metadata JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_knowledge_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  INDEX idx_knowledge_org_source (org_id, source_file)
);
CREATE TABLE IF NOT EXISTS call_recordings (
  id CHAR(36) PRIMARY KEY, conversation_id CHAR(36) NOT NULL, s3_key VARCHAR(500) NOT NULL,
  duration_seconds INT NULL, transcript TEXT NULL, highlights JSON NULL, quality_score DECIMAL(5,2) NULL,
  file_size_bytes BIGINT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_recordings_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS daily_metrics (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, date DATE NOT NULL, total_conversations INT NOT NULL DEFAULT 0,
  voice_conversations INT NOT NULL DEFAULT 0, whatsapp_conversations INT NOT NULL DEFAULT 0, telegram_conversations INT NOT NULL DEFAULT 0,
  leads_created INT NOT NULL DEFAULT 0, leads_converted INT NOT NULL DEFAULT 0, avg_response_time_ms INT NOT NULL DEFAULT 0,
  avg_conversation_duration_sec INT NOT NULL DEFAULT 0, top_objections JSON NULL, tokens_input_total BIGINT NOT NULL DEFAULT 0,
  tokens_output_total BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_metrics_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE, UNIQUE KEY uq_metrics_org_date (org_id, date)
);
CREATE TABLE IF NOT EXISTS crm_connections (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, crm_type VARCHAR(50) NOT NULL DEFAULT 'amocrm', domain VARCHAR(255) NOT NULL,
  access_token TEXT NULL, refresh_token TEXT NULL, token_expires_at TIMESTAMP NULL, pipeline_id VARCHAR(100) NULL,
  stage_mapping JSON NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, last_sync_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_crm_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE, UNIQUE KEY uq_crm_org_type (org_id, crm_type)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, plan VARCHAR(50) NOT NULL DEFAULT 'trial', stripe_subscription_id VARCHAR(255) NULL,
  stripe_customer_id VARCHAR(255) NULL, minutes_used INT NOT NULL DEFAULT 0, messages_used INT NOT NULL DEFAULT 0,
  minutes_limit INT NOT NULL DEFAULT 100, messages_limit INT NOT NULL DEFAULT 1000,
  current_period_start TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, current_period_end TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) NOT NULL DEFAULT 'active', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_subscriptions_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE, UNIQUE KEY uq_subscriptions_org (org_id)
);
CREATE TABLE IF NOT EXISTS usage_events (
  id CHAR(36) PRIMARY KEY, org_id CHAR(36) NOT NULL, conversation_id CHAR(36) NULL, event_type VARCHAR(50) NOT NULL,
  quantity INT NOT NULL DEFAULT 1, cost_tiyin INT NOT NULL DEFAULT 0, metadata JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_usage_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE, INDEX idx_usage_org_created (org_id, created_at)
);
