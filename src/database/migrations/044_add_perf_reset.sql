-- Shopping list reset: tracks when a vendor has reset their performance history.
-- Aggregations filter to logs created AFTER this timestamp (NULL = no reset, include everything).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS perf_reset_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_perf_reset_at ON users(perf_reset_at);
