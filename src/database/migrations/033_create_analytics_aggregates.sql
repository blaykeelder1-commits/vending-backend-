-- Analytics Aggregates Tables
-- Migration: 033_create_analytics_aggregates.sql
-- Pre-computed analytics summaries for efficient dashboard queries

-- Daily machine analytics (pre-aggregated for historical data)
CREATE TABLE IF NOT EXISTS analytics_daily_machine (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  qr_scans INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  poll_views INTEGER NOT NULL DEFAULT 0,
  poll_votes INTEGER NOT NULL DEFAULT 0,
  suggestions INTEGER NOT NULL DEFAULT 0,
  unique_sessions INTEGER NOT NULL DEFAULT 0,
  avg_session_duration_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(machine_id, date)
);

-- Indexes for daily analytics
CREATE INDEX IF NOT EXISTS idx_analytics_daily_machine_vendor ON analytics_daily_machine(vendor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_machine_date ON analytics_daily_machine(date DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_machine_vendor_date ON analytics_daily_machine(vendor_id, date DESC);

-- Hourly machine analytics (rolling 48-hour window for real-time dashboards)
CREATE TABLE IF NOT EXISTS analytics_hourly_machine (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hour_start TIMESTAMP WITH TIME ZONE NOT NULL,
  qr_scans INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  poll_views INTEGER NOT NULL DEFAULT 0,
  poll_votes INTEGER NOT NULL DEFAULT 0,
  suggestions INTEGER NOT NULL DEFAULT 0,
  unique_sessions INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(machine_id, hour_start)
);

-- Indexes for hourly analytics
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_machine_vendor ON analytics_hourly_machine(vendor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_machine_hour ON analytics_hourly_machine(hour_start DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_machine_vendor_hour ON analytics_hourly_machine(vendor_id, hour_start DESC);

-- Weekly vendor summary (aggregated across all machines)
CREATE TABLE IF NOT EXISTS analytics_vendor_weekly (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  total_qr_scans INTEGER NOT NULL DEFAULT 0,
  total_page_views INTEGER NOT NULL DEFAULT 0,
  total_poll_votes INTEGER NOT NULL DEFAULT 0,
  total_suggestions INTEGER NOT NULL DEFAULT 0,
  total_unique_sessions INTEGER NOT NULL DEFAULT 0,
  active_machines INTEGER NOT NULL DEFAULT 0,
  engagement_score DECIMAL(10, 2) DEFAULT 0,
  top_machine_id INTEGER REFERENCES vending_machines(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(vendor_id, week_start)
);

-- Indexes for weekly analytics
CREATE INDEX IF NOT EXISTS idx_analytics_vendor_weekly_vendor ON analytics_vendor_weekly(vendor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_vendor_weekly_week ON analytics_vendor_weekly(week_start DESC);

-- Trigger for updated_at on daily aggregates
DROP TRIGGER IF EXISTS update_analytics_daily_machine_updated_at ON analytics_daily_machine;
CREATE TRIGGER update_analytics_daily_machine_updated_at
  BEFORE UPDATE ON analytics_daily_machine
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger for updated_at on weekly aggregates
DROP TRIGGER IF EXISTS update_analytics_vendor_weekly_updated_at ON analytics_vendor_weekly;
CREATE TRIGGER update_analytics_vendor_weekly_updated_at
  BEFORE UPDATE ON analytics_vendor_weekly
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE analytics_daily_machine IS 'Daily aggregated analytics per machine';
COMMENT ON TABLE analytics_hourly_machine IS 'Hourly analytics for real-time dashboards (48-hour rolling window)';
COMMENT ON TABLE analytics_vendor_weekly IS 'Weekly vendor-level analytics summary with engagement scores';
COMMENT ON COLUMN analytics_vendor_weekly.engagement_score IS 'Weighted score: (scans*1) + (votes*3) + (suggestions*5)';
