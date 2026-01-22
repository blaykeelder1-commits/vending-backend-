-- Add Google OAuth fields to users table
-- Migration: 028_add_google_oauth.sql

-- Add google_id column for Google's unique user ID
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

-- Add auth_provider column to track authentication method ('local' or 'google')
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'local';

-- Add avatar_url column for Google profile picture
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);

-- Create index on google_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;

-- Update existing users to have 'local' auth_provider
UPDATE users SET auth_provider = 'local' WHERE auth_provider IS NULL;
