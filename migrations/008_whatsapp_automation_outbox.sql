-- Durable WhatsApp automation state, human handoff attribution and an
-- idempotent delivery outbox. The outbox never stores device credentials.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reply_mode VARCHAR(16) NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS mode_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_reply_mode_check
  CHECK (reply_mode IN ('ai', 'operator'));

ALTER TABLE conversations
  ADD CONSTRAINT conversations_mode_version_check
  CHECK (mode_version >= 0);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_type VARCHAR(16),
  ADD COLUMN IF NOT EXISTS author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS external_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sequence_id BIGSERIAL;

UPDATE messages
SET sender_type = CASE role
  WHEN 'user' THEN 'customer'
  WHEN 'assistant' THEN 'ai'
  WHEN 'tool' THEN 'system'
  ELSE 'system'
END
WHERE sender_type IS NULL;

UPDATE messages
SET delivery_status = CASE role
  WHEN 'user' THEN 'received'
  WHEN 'assistant' THEN 'sent'
  ELSE 'not_applicable'
END
WHERE delivery_status IS NULL;

ALTER TABLE messages
  ALTER COLUMN sender_type SET NOT NULL,
  ALTER COLUMN delivery_status SET NOT NULL,
  ALTER COLUMN sequence_id SET NOT NULL;

ALTER TABLE messages
  ADD CONSTRAINT messages_sender_type_check
  CHECK (sender_type IN ('customer', 'ai', 'operator', 'system'));

ALTER TABLE messages
  ADD CONSTRAINT messages_delivery_status_check
  CHECK (delivery_status IN (
    'received', 'pending', 'sending', 'sent', 'failed', 'cancelled',
    'not_applicable'
  ));

CREATE OR REPLACE FUNCTION set_message_delivery_defaults()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_type IS NULL THEN
    NEW.sender_type := CASE NEW.role
      WHEN 'user' THEN 'customer'
      WHEN 'assistant' THEN 'ai'
      ELSE 'system'
    END;
  END IF;
  IF NEW.delivery_status IS NULL THEN
    NEW.delivery_status := CASE NEW.role
      WHEN 'user' THEN 'received'
      WHEN 'assistant' THEN 'sent'
      ELSE 'not_applicable'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_delivery_defaults ON messages;
CREATE TRIGGER trg_message_delivery_defaults
BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION set_message_delivery_defaults();

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_external
  ON messages(conversation_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sequence
  ON messages(sequence_id);

CREATE TABLE whatsapp_outbox (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id          UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  phone               VARCHAR(30) NOT NULL,
  reply_jid           VARCHAR(255) NOT NULL,
  text                TEXT NOT NULL,
  kind                VARCHAR(20) NOT NULL
                      CHECK (kind IN ('ai', 'control', 'operator', 'rate_limit', 'follow_up')),
  idempotency_key     VARCHAR(255) NOT NULL,
  required_mode       VARCHAR(16)
                      CHECK (required_mode IS NULL OR required_mode IN ('ai', 'operator')),
  required_version    INTEGER,
  status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at           TIMESTAMPTZ,
  provider_message_id VARCHAR(255),
  last_error_code     VARCHAR(80),
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX idx_whatsapp_outbox_due
  ON whatsapp_outbox(status, available_at)
  WHERE status IN ('pending', 'failed', 'sending');
