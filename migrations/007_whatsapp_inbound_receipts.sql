-- Deduplicate WhatsApp Web delivery retries without storing message text or
-- device credentials in PostgreSQL.
CREATE TABLE whatsapp_inbound_receipts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id   VARCHAR(255) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'processed', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, message_id)
);

CREATE INDEX idx_whatsapp_receipts_created
  ON whatsapp_inbound_receipts(created_at);
