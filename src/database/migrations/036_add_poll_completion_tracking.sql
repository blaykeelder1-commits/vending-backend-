-- Add device fingerprint tracking columns to customer_sessions
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR(64);
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS screen_resolution VARCHAR(20);
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS timezone VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_sessions_device_fingerprint ON customer_sessions(device_fingerprint);

-- Create poll_completions table to track who finished a poll
CREATE TABLE IF NOT EXISTS poll_completions (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES customer_sessions(id) ON DELETE CASCADE,
  device_fingerprint VARCHAR(64),
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraint: one completion per poll per session
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_completions_unique
  ON poll_completions(poll_id, session_id);

-- Index for device fingerprint lookups (repeat-vote detection)
CREATE INDEX IF NOT EXISTS idx_poll_completions_fingerprint
  ON poll_completions(device_fingerprint);

CREATE INDEX IF NOT EXISTS idx_poll_completions_poll
  ON poll_completions(poll_id);
