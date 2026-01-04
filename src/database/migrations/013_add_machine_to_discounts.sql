-- Add machine_id to discount_codes table
ALTER TABLE discount_codes
  ADD COLUMN IF NOT EXISTS machine_id INTEGER REFERENCES vending_machines(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_discounts_machine ON discount_codes(machine_id);
