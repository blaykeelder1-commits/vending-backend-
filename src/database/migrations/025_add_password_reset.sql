-- Migration: Add password reset fields to users table
-- Purpose: Enable password reset via email link for vendors

-- Add password reset columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(64);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMP;

-- Index for efficient lookup by reset token
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token) WHERE password_reset_token IS NOT NULL;

COMMENT ON COLUMN users.password_reset_token IS 'Secure token for password reset (SHA256 hash stored, raw token sent to user)';
COMMENT ON COLUMN users.password_reset_expires IS 'When the password reset token expires (1 hour from generation)';
