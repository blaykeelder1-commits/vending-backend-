-- Central inventory tracking for vendor warehouse/bulk stock
CREATE TABLE IF NOT EXISTS vendor_inventory (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  reorder_threshold INTEGER NOT NULL DEFAULT 10 CHECK (reorder_threshold >= 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One row per product per vendor
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_inventory_unique
  ON vendor_inventory(vendor_id, product_id);

CREATE INDEX IF NOT EXISTS idx_vendor_inventory_vendor
  ON vendor_inventory(vendor_id);

-- Audit trail for all inventory movements
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  transaction_type VARCHAR(30) NOT NULL,
  quantity INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  machine_id INTEGER REFERENCES vending_machines(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inv_txn_vendor
  ON inventory_transactions(vendor_id);

CREATE INDEX IF NOT EXISTS idx_inv_txn_product
  ON inventory_transactions(product_id);

CREATE INDEX IF NOT EXISTS idx_inv_txn_machine
  ON inventory_transactions(machine_id);

CREATE INDEX IF NOT EXISTS idx_inv_txn_type
  ON inventory_transactions(transaction_type);

CREATE INDEX IF NOT EXISTS idx_inv_txn_created
  ON inventory_transactions(created_at DESC);

-- Partial index for low-stock alert queries
CREATE INDEX IF NOT EXISTS idx_vendor_inventory_low_stock
  ON vendor_inventory(vendor_id)
  WHERE quantity_on_hand <= reorder_threshold;
