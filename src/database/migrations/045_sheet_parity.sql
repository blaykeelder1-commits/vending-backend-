-- 045: parity with the Snak inventory sheet (2026-11-12)
-- Fleet-level product facts the sheet tracks by hand, plus the blacklist with its re-intro hold.

ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(10, 2) CHECK (unit_cost IS NULL OR unit_cost >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier VARCHAR(120);
-- "Full Stock Capacity" across the whole fleet; sell-through = units sold in window / this
ALTER TABLE products ADD COLUMN IF NOT EXISTS full_capacity INTEGER CHECK (full_capacity IS NULL OR full_capacity >= 0);

CREATE INDEX IF NOT EXISTS idx_products_vendor_sku ON products(vendor_id, sku) WHERE sku IS NOT NULL;

-- Products pulled from the fleet. Re-intro eligibility = blacklisted_at + hold (config/rules.js).
CREATE TABLE IF NOT EXISTS product_blacklist (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(255) NOT NULL, -- kept even if the product row is later deleted
  reason TEXT,
  sold_in_window INTEGER,             -- snapshot of sales when pulled
  blacklisted_at DATE NOT NULL DEFAULT CURRENT_DATE,
  reintroduced_at DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blacklist_vendor ON product_blacklist(vendor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_active_unique
  ON product_blacklist(vendor_id, lower(product_name)) WHERE reintroduced_at IS NULL;
