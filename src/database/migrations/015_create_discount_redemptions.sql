-- Create discount_redemptions table to track customer redemptions
CREATE TABLE IF NOT EXISTS discount_redemptions (
  id SERIAL PRIMARY KEY,
  discount_code_id INTEGER NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_redemptions_code ON discount_redemptions(discount_code_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_customer ON discount_redemptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_machine ON discount_redemptions(machine_id);

-- Prevent duplicate redemptions by same customer
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_unique
  ON discount_redemptions(discount_code_id, customer_id)
  WHERE customer_id IS NOT NULL;
