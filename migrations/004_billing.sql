-- ============================================================
-- Migration 004: Биллинг и подписки
-- ============================================================

CREATE TABLE subscriptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan                  VARCHAR(50)  NOT NULL DEFAULT 'trial',
  stripe_subscription_id VARCHAR(255),
  stripe_customer_id    VARCHAR(255),
  -- Использование (в тийынах/копейках для избежания float)
  minutes_used          INTEGER NOT NULL DEFAULT 0,
  messages_used         INTEGER NOT NULL DEFAULT 0,
  -- Лимиты текущего плана
  minutes_limit         INTEGER NOT NULL DEFAULT 100,
  messages_limit        INTEGER NOT NULL DEFAULT 1000,
  -- Период
  current_period_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  status                VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id)
);

CREATE INDEX idx_subscriptions_org    ON subscriptions(org_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);

CREATE TRIGGER trg_subscriptions_updated
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Использование ресурсов (для биллинга)
-- ============================================================
CREATE TABLE usage_events (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id),
  event_type       VARCHAR(50) NOT NULL,  -- 'minute_used', 'message_sent', 'api_call'
  quantity         INTEGER NOT NULL DEFAULT 1,
  -- Стоимость в тийынах (1 тенге = 100 тийын)
  cost_tiyin       INTEGER NOT NULL DEFAULT 0,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_org_created ON usage_events(org_id, created_at DESC);
CREATE INDEX idx_usage_org_type    ON usage_events(org_id, event_type);
