-- Machine History / Visit Memory System
-- Migration: 035_create_machine_history.sql
-- Tracks all actions taken on machines for visit-to-visit comparison

-- Create machine_history table
CREATE TABLE IF NOT EXISTS machine_history (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES users(id),
  action_type VARCHAR(50) NOT NULL,
  -- action_type values:
  -- 'visit' - Vendor visited/checked in
  -- 'performance_change' - Changed performing status
  -- 'product_added' - Added product to machine
  -- 'product_removed' - Removed product from machine
  -- 'stock_updated' - Updated stock quantity
  -- 'note_updated' - Updated machine notes

  -- Context data (JSON for flexibility)
  details JSONB DEFAULT '{}',
  -- Examples:
  -- performance_change: {"product_id": 1, "product_name": "Chips", "old_status": null, "new_status": true}
  -- product_added: {"product_id": 1, "product_name": "Chips", "initial_stock": 10}
  -- product_removed: {"product_id": 1, "product_name": "Chips", "reason": "manual"}

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for fetching history by machine, ordered by time (most recent first)
CREATE INDEX IF NOT EXISTS idx_machine_history_machine_time
  ON machine_history(machine_id, created_at DESC);

-- Index for filtering by action type within a machine
CREATE INDEX IF NOT EXISTS idx_machine_history_machine_action
  ON machine_history(machine_id, action_type);

-- Index for filtering by vendor
CREATE INDEX IF NOT EXISTS idx_machine_history_vendor
  ON machine_history(vendor_id, created_at DESC);

-- Add last_visit_at column to vending_machines table
ALTER TABLE vending_machines
  ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Index for sorting machines by last visit
CREATE INDEX IF NOT EXISTS idx_vending_machines_last_visit
  ON vending_machines(vendor_id, last_visit_at DESC NULLS LAST);

-- Comments for documentation
COMMENT ON TABLE machine_history IS 'Audit log of all vendor actions on machines for visit memory feature';
COMMENT ON COLUMN machine_history.action_type IS 'Type of action: visit, performance_change, product_added, product_removed, stock_updated, note_updated';
COMMENT ON COLUMN machine_history.details IS 'JSON context data specific to each action type';
COMMENT ON COLUMN vending_machines.last_visit_at IS 'Timestamp when vendor last opened/interacted with this machine';
