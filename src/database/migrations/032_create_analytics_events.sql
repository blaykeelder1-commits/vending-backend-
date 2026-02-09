-- Analytics Events Table
-- Migration: 032_create_analytics_events.sql
-- Tracks raw analytics events (QR scans, page views, poll interactions, suggestions)

-- Create analytics_events table for raw event tracking
CREATE TABLE IF NOT EXISTS analytics_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  machine_id INTEGER REFERENCES vending_machines(id) ON DELETE CASCADE,
  vendor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES customer_sessions(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_analytics_events_machine_id ON analytics_events(machine_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_vendor_id ON analytics_events(vendor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_machine_time ON analytics_events(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_vendor_time ON analytics_events(vendor_id, created_at DESC);

-- Composite index for common queries (vendor dashboard, machine analytics)
CREATE INDEX IF NOT EXISTS idx_analytics_events_vendor_type_time
  ON analytics_events(vendor_id, event_type, created_at DESC);

-- Add comment for documentation
COMMENT ON TABLE analytics_events IS 'Raw analytics events for QR scans, page views, poll votes, and suggestions';
COMMENT ON COLUMN analytics_events.event_type IS 'Event types: qr_scan, page_view, poll_view, poll_vote, suggestion_submit';
COMMENT ON COLUMN analytics_events.metadata IS 'Additional event-specific data (poll_id, vote_type, etc.)';
