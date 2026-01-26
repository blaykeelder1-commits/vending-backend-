-- Top 50 Products Learning Algorithm
-- Migration: 029_top50_algorithm.sql
-- Creates cached rankings table and supporting indexes

-- Create product_rankings table for caching calculated rankings
CREATE TABLE IF NOT EXISTS product_rankings (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  ranking_score DECIMAL(10, 2) NOT NULL DEFAULT 0,
  rank_position INTEGER NOT NULL DEFAULT 0,
  yes_count INTEGER NOT NULL DEFAULT 0,
  no_count INTEGER NOT NULL DEFAULT 0,
  unique_vendors INTEGER NOT NULL DEFAULT 0,
  calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookups by rank position
CREATE INDEX IF NOT EXISTS idx_product_rankings_rank_position ON product_rankings(rank_position);

-- Index for fast lookups by ranking score
CREATE INDEX IF NOT EXISTS idx_product_rankings_score ON product_rankings(ranking_score DESC);

-- Index on product_performance_log.created_at for efficient queries (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'product_performance_log') THEN
    CREATE INDEX IF NOT EXISTS idx_product_performance_log_created_at ON product_performance_log(created_at);
  END IF;
END $$;

-- Add index on machine_products for faster vendor diversity queries
CREATE INDEX IF NOT EXISTS idx_machine_products_performing ON machine_products(product_id, is_performing) WHERE is_performing IS NOT NULL;

-- Create or replace view for global product stats with vendor diversity
CREATE OR REPLACE VIEW global_product_stats_v2 AS
SELECT
  p.id as product_id,
  p.product_name,
  p.image_url,
  COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as yes_count,
  COUNT(CASE WHEN mp.is_performing = false THEN 1 END) as no_count,
  COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END) as total_ratings,
  COUNT(DISTINCT vm.vendor_id) as unique_vendors,
  ROUND(
    COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 /
    NULLIF(COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END), 0),
    1
  ) as performance_percentage
FROM products p
JOIN machine_products mp ON p.id = mp.product_id
JOIN vending_machines vm ON mp.machine_id = vm.id
WHERE mp.is_performing IS NOT NULL
GROUP BY p.id, p.product_name, p.image_url
HAVING COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END) >= 1;
