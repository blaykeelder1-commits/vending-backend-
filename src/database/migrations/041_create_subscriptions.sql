-- Add subscription fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT 'free'
  CHECK (subscription_tier IN ('free', 'growth', 'pro', 'business'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS square_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS square_subscription_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_start TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS machine_limit INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_users_square_customer ON users(square_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_square_subscription ON users(square_subscription_id);
CREATE INDEX IF NOT EXISTS idx_users_subscription_tier ON users(subscription_tier);

-- Subscription events log (audit trail for all subscription lifecycle changes)
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  from_tier VARCHAR(20),
  to_tier VARCHAR(20),
  square_event_id VARCHAR(255) UNIQUE,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user ON subscription_events(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_type ON subscription_events(event_type);

COMMENT ON COLUMN subscription_events.event_type IS 'upgrade, downgrade, cancel, trial_start, trial_end, payment_failed, reactivate, pause, resume';
