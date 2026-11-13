-- 046: per-vendor read-only API keys (Muse, Google Sheets mirror, other integrations)
-- Only a SHA-256 hash is stored; the key itself is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,          -- shown in the UI to identify the key
  key_hash CHAR(64) NOT NULL UNIQUE,        -- sha256 hex of the full key
  scope VARCHAR(20) NOT NULL DEFAULT 'read' CHECK (scope IN ('read')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_keys_vendor ON api_keys(vendor_id);
