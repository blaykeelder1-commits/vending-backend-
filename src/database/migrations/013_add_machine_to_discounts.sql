-- Add machine_id to discount_codes table
ALTER TABLE discount_codes
  ADD COLUMN machine_id INTEGER REFERENCES vending_machines(id) ON DELETE CASCADE;

CREATE INDEX idx_discounts_machine ON discount_codes(machine_id);
