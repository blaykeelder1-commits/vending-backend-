-- Migration: Create product redistributions table for tracking product transfers between machines
-- This table provides an audit trail for product redistribution to reduce spoilage

CREATE TABLE IF NOT EXISTS product_redistributions (
  id SERIAL PRIMARY KEY,
  source_machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  target_machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_transferred INTEGER NOT NULL CHECK (quantity_transferred > 0),
  reason TEXT,
  performed_by INTEGER NOT NULL REFERENCES users(id),
  source_stock_before INTEGER NOT NULL,
  source_stock_after INTEGER NOT NULL,
  target_stock_before INTEGER NOT NULL,
  target_stock_after INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_redistribution_source ON product_redistributions(source_machine_id);
CREATE INDEX IF NOT EXISTS idx_redistribution_target ON product_redistributions(target_machine_id);
CREATE INDEX IF NOT EXISTS idx_redistribution_product ON product_redistributions(product_id);
CREATE INDEX IF NOT EXISTS idx_redistribution_date ON product_redistributions(created_at);
