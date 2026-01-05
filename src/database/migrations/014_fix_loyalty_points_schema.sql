-- Fix loyalty_points table to support balance tracking
-- Add balance and lifetime tracking columns
ALTER TABLE loyalty_points
  ADD COLUMN IF NOT EXISTS points_balance INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_points INTEGER DEFAULT 0;

-- Add updated_at if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'loyalty_points' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE loyalty_points ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

-- Add unique constraint for customer+machine (ignore if exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_customer_machine'
  ) THEN
    ALTER TABLE loyalty_points ADD CONSTRAINT unique_customer_machine UNIQUE (customer_id, machine_id);
  END IF;
END $$;

-- Create trigger for updated_at if not exists
DROP TRIGGER IF EXISTS update_loyalty_points_updated_at ON loyalty_points;
CREATE TRIGGER update_loyalty_points_updated_at
  BEFORE UPDATE ON loyalty_points
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
