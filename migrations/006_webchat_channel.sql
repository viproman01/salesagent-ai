-- Persistent browser chat. The enum value becomes usable after this migration
-- transaction commits; statements below intentionally operate only on TEXT
-- columns and do not cast to the new enum value.
ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'webchat';

UPDATE agents
SET channels = array_append(channels, 'webchat'),
    updated_at = NOW()
WHERE is_active = true
  AND NOT ('webchat' = ANY(channels));

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_webchat_session
  ON conversations(org_id, external_id)
  WHERE external_id LIKE 'webchat:%';
