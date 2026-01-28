-- Add IP change tracking for session hijacking prevention
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS ip_change_count INTEGER DEFAULT 0;
