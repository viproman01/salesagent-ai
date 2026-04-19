-- ============================================================
-- Migration 002: Индексы, триггеры и вспомогательные функции
-- ============================================================

-- ---- Индексы для organizations ----
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_country ON organizations(country);

-- ---- Индексы для users ----
CREATE INDEX idx_users_organization_id ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);

-- ---- Индексы для agents ----
CREATE INDEX idx_agents_organization_id ON agents(organization_id);
CREATE INDEX idx_agents_active ON agents(organization_id, is_active);

-- ---- Индексы для leads ----
CREATE INDEX idx_leads_organization_id ON leads(organization_id);
CREATE INDEX idx_leads_agent_id ON leads(agent_id);
CREATE INDEX idx_leads_stage ON leads(organization_id, stage);
CREATE INDEX idx_leads_source ON leads(source_channel, source_id);
CREATE INDEX idx_leads_next_contact ON leads(next_contact_at) WHERE next_contact_at IS NOT NULL;
CREATE INDEX idx_leads_crm_id ON leads(crm_id) WHERE crm_id IS NOT NULL;
-- Полнотекстовый поиск по имени и телефону лида
CREATE INDEX idx_leads_search ON leads USING gin(to_tsvector('russian', COALESCE(name, '') || ' ' || COALESCE(phone, '')));

-- ---- Индексы для conversations ----
CREATE INDEX idx_conversations_organization_id ON conversations(organization_id);
CREATE INDEX idx_conversations_agent_id ON conversations(agent_id);
CREATE INDEX idx_conversations_lead_id ON conversations(lead_id);
CREATE INDEX idx_conversations_status ON conversations(organization_id, status);
CREATE INDEX idx_conversations_channel ON conversations(channel, channel_chat_id);
CREATE INDEX idx_conversations_started_at ON conversations(organization_id, started_at DESC);

-- ---- Индексы для messages ----
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_role ON messages(conversation_id, role);

-- ---- Индексы для knowledge_chunks ----
CREATE INDEX idx_knowledge_organization_id ON knowledge_chunks(organization_id);
CREATE INDEX idx_knowledge_agent_id ON knowledge_chunks(agent_id);
CREATE INDEX idx_knowledge_category ON knowledge_chunks(organization_id, category);
CREATE INDEX idx_knowledge_active ON knowledge_chunks(organization_id, is_active);
-- Полнотекстовый поиск по контенту (для гибридного поиска)
CREATE INDEX idx_knowledge_content_fts ON knowledge_chunks USING gin(to_tsvector('russian', COALESCE(title, '') || ' ' || content));
-- HNSW индекс для векторного поиска (быстрее IVFFlat для продакшна)
CREATE INDEX idx_knowledge_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ---- Индексы для call_recordings ----
CREATE INDEX idx_recordings_organization_id ON call_recordings(organization_id);
CREATE INDEX idx_recordings_conversation_id ON call_recordings(conversation_id);
CREATE INDEX idx_recordings_lead_id ON call_recordings(lead_id);
CREATE INDEX idx_recordings_created_at ON call_recordings(organization_id, created_at DESC);

-- ---- Индексы для subscriptions ----
CREATE INDEX idx_subscriptions_organization_id ON subscriptions(organization_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- ============================================================
-- Функция и триггер: автоматическое обновление updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Применяем триггер ко всем таблицам с updated_at
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_knowledge_chunks_updated_at
  BEFORE UPDATE ON knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_crm_connections_updated_at
  BEFORE UPDATE ON crm_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Функция: автоматическое обновление last_contact_at у лида
-- при появлении нового сообщения в его диалоге
-- ============================================================
CREATE OR REPLACE FUNCTION update_lead_last_contact()
RETURNS TRIGGER AS $$
BEGIN
  -- Обновляем время последнего контакта только для сообщений от пользователя
  IF NEW.role = 'user' THEN
    UPDATE leads l
    SET last_contact_at = NOW()
    FROM conversations c
    WHERE c.id = NEW.conversation_id
      AND c.lead_id = l.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_update_lead_contact
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION update_lead_last_contact();

-- ============================================================
-- Функция: счётчик использованных диалогов в подписке
-- ============================================================
CREATE OR REPLACE FUNCTION increment_dialogs_used()
RETURNS TRIGGER AS $$
BEGIN
  -- При создании нового диалога увеличиваем счётчик
  IF NEW.status = 'active' AND (OLD IS NULL OR OLD.status != 'active') THEN
    UPDATE subscriptions s
    SET dialogs_used = dialogs_used + 1
    FROM organizations o
    WHERE o.id = NEW.organization_id
      AND s.organization_id = o.id
      AND s.status IN ('active', 'trial');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_conversations_count_dialogs
  AFTER INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION increment_dialogs_used();
