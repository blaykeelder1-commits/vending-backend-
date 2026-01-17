-- Migration: Add Machine Notes, Expiration Tracking, and Product Suggestions
-- Simple, practical features for vendor efficiency

-- ============================================
-- STEP 1: Add notes to vending machines
-- ============================================
-- Allows vendors to save notes per machine (e.g., "key under mat", "call Bob for access")

ALTER TABLE vending_machines
ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;

-- ============================================
-- STEP 2: Add expiration date tracking to inventory
-- ============================================
-- Allows vendors to track expiration dates and get alerts

ALTER TABLE machine_products
ADD COLUMN IF NOT EXISTS expiration_date DATE DEFAULT NULL;

-- Create index for expiration queries
CREATE INDEX IF NOT EXISTS idx_machine_products_expiration ON machine_products(expiration_date)
WHERE expiration_date IS NOT NULL;

-- ============================================
-- STEP 3: Create product suggestions table
-- ============================================
-- Allows customers to suggest products they'd like to see

CREATE TABLE IF NOT EXISTS product_suggestions (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  suggestion_text VARCHAR(255) NOT NULL,
  customer_session_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'added', 'dismissed')),
  vendor_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP DEFAULT NULL
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_suggestions_machine ON product_suggestions(machine_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON product_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_suggestions_created ON product_suggestions(created_at DESC);

-- ============================================
-- STEP 4: Create view for expiring products
-- ============================================
-- Makes it easy to query products expiring soon

CREATE OR REPLACE VIEW expiring_products AS
SELECT
  mp.id as inventory_id,
  mp.machine_id,
  vm.machine_name,
  vm.location,
  vm.vendor_id,
  mp.product_id,
  p.product_name,
  mp.current_stock,
  mp.expiration_date,
  mp.expiration_date - CURRENT_DATE as days_until_expiration
FROM machine_products mp
JOIN vending_machines vm ON mp.machine_id = vm.id
JOIN products p ON mp.product_id = p.id
WHERE mp.expiration_date IS NOT NULL
  AND mp.expiration_date <= CURRENT_DATE + INTERVAL '14 days'
  AND mp.current_stock > 0
ORDER BY mp.expiration_date ASC;
