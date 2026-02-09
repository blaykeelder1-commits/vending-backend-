-- Session Engagement Tracking
-- Migration: 034_add_session_engagement.sql
-- Adds engagement metrics to customer_sessions table

-- Add engagement tracking columns to customer_sessions
ALTER TABLE customer_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS page_views INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 0;

-- Index for last activity queries
CREATE INDEX IF NOT EXISTS idx_customer_sessions_last_activity ON customer_sessions(last_activity_at DESC);

-- Function to calculate session duration when session ends
CREATE OR REPLACE FUNCTION calculate_session_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.last_activity_at IS NOT NULL AND OLD.last_activity_at IS DISTINCT FROM NEW.last_activity_at THEN
    NEW.duration_seconds := EXTRACT(EPOCH FROM (NEW.last_activity_at - NEW.created_at))::INTEGER;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-calculate duration
DROP TRIGGER IF EXISTS calculate_session_duration_trigger ON customer_sessions;
CREATE TRIGGER calculate_session_duration_trigger
  BEFORE UPDATE ON customer_sessions
  FOR EACH ROW EXECUTE FUNCTION calculate_session_duration();

-- Comments for documentation
COMMENT ON COLUMN customer_sessions.last_activity_at IS 'Timestamp of last user activity in this session';
COMMENT ON COLUMN customer_sessions.page_views IS 'Number of page views in this session';
COMMENT ON COLUMN customer_sessions.duration_seconds IS 'Total session duration in seconds (auto-calculated)';
