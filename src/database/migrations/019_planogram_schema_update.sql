-- Migration: Planogram Schema Update
-- Removes discount/loyalty system, adds performance tracking

-- ============================================
-- STEP 1: Drop discount and loyalty tables
-- ============================================

-- Drop views first (if they exist)
DROP VIEW IF EXISTS customer_loyalty_totals CASCADE;

-- Drop tables (order matters due to foreign keys)
DROP TABLE IF EXISTS discount_redemptions CASCADE;
DROP TABLE IF EXISTS discount_codes CASCADE;
DROP TABLE IF EXISTS loyalty_points CASCADE;
DROP TABLE IF EXISTS rebates CASCADE;

-- ============================================
-- STEP 2: Add performance tracking to machine_products
-- ============================================

-- Add is_performing column (NULL = not yet marked, true = doing good, false = not doing good)
ALTER TABLE machine_products
ADD COLUMN IF NOT EXISTS is_performing BOOLEAN DEFAULT NULL;

-- Add timestamp for when performance was last marked
ALTER TABLE machine_products
ADD COLUMN IF NOT EXISTS performance_marked_at TIMESTAMP DEFAULT NULL;

-- Create index for performance queries
CREATE INDEX IF NOT EXISTS idx_machine_products_performing ON machine_products(is_performing);

-- ============================================
-- STEP 3: Create product performance log for history tracking
-- ============================================

CREATE TABLE IF NOT EXISTS product_performance_log (
  id SERIAL PRIMARY KEY,
  machine_product_id INTEGER NOT NULL REFERENCES machine_products(id) ON DELETE CASCADE,
  is_performing BOOLEAN NOT NULL,
  marked_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_perf_log_machine_product ON product_performance_log(machine_product_id);
CREATE INDEX IF NOT EXISTS idx_perf_log_created ON product_performance_log(created_at);

-- ============================================
-- STEP 4: Create global product stats for Top 50 feature
-- ============================================

-- This view aggregates "yes" (is_performing = true) counts across all vendors
CREATE OR REPLACE VIEW global_product_stats AS
SELECT
  p.id as product_id,
  p.product_name,
  p.image_url,
  COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as yes_count,
  COUNT(CASE WHEN mp.is_performing = false THEN 1 END) as no_count,
  COUNT(mp.id) as total_machines,
  ROUND(
    COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 / NULLIF(COUNT(mp.id), 0),
    1
  ) as performance_percentage
FROM products p
LEFT JOIN machine_products mp ON p.id = mp.product_id
WHERE mp.is_performing IS NOT NULL
GROUP BY p.id, p.product_name, p.image_url
ORDER BY yes_count DESC, performance_percentage DESC;

-- ============================================
-- STEP 5: Modify poll_votes for anonymous swipe voting
-- ============================================

-- Update vote_type constraint to use swipe terminology (keeping like/dislike for compatibility)
-- 'like' = swipe right (want it), 'dislike' = swipe left (don't want it)

-- Make customer_id nullable (for anonymous voting) - already is
-- Add check that at least session_id or some identifier exists

-- Create view for swipe results per machine
CREATE OR REPLACE VIEW swipe_poll_results AS
SELECT
  p.id as poll_id,
  p.machine_id,
  p.poll_question,
  po.id as option_id,
  po.option_text as product_name,
  po.image_url,
  COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) as swipe_right_count,
  COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END) as swipe_left_count,
  COUNT(pv.id) as total_votes,
  ROUND(
    COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) * 100.0 / NULLIF(COUNT(pv.id), 0),
    1
  ) as approval_percentage
FROM polls p
JOIN poll_options po ON p.id = po.poll_id
LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
WHERE p.is_active = true
GROUP BY p.id, p.machine_id, p.poll_question, po.id, po.option_text, po.image_url
ORDER BY swipe_right_count DESC;

-- ============================================
-- STEP 6: Seed sample products for testing
-- ============================================

-- Insert common vending machine products (if products table is empty for a vendor)
-- This is optional seed data - vendors can add their own
