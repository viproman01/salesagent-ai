CREATE TABLE IF NOT EXISTS webhook_events (
  id CHAR(36) PRIMARY KEY,
  org_id CHAR(36) NOT NULL,
  provider VARCHAR(30) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing',
  error_message VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  CONSTRAINT fk_webhook_events_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_webhook_provider_event (provider, event_id),
  INDEX idx_webhook_org_created (org_id, created_at)
);
