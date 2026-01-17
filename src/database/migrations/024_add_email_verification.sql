-- Migration: Add email verification fields to users table
-- Purpose: Enable email verification for vendor signups

-- Add email verification columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS email_verification_code VARCHAR(6);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMP;

-- Index for efficient lookup by verification code
CREATE INDEX IF NOT EXISTS idx_users_verification_code ON users(email_verification_code) WHERE email_verification_code IS NOT NULL;

-- Update existing users to be verified (grandfathered in)
UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL OR email_verified = FALSE;

COMMENT ON COLUMN users.email_verified IS 'Whether the user has verified their email address';
COMMENT ON COLUMN users.email_verification_code IS '6-digit verification code sent via email';
COMMENT ON COLUMN users.email_verification_expires IS 'When the verification code expires (15 minutes from generation)';
