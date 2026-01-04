-- Create rebates table
CREATE TABLE IF NOT EXISTS rebates (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  discount_code_id INTEGER REFERENCES discount_codes(id) ON DELETE SET NULL,
  discount_code_used VARCHAR(50),
  purchase_amount DECIMAL(10, 2) NOT NULL CHECK (purchase_amount >= 0),
  rebate_amount DECIMAL(10, 2) NOT NULL CHECK (rebate_amount >= 0),
  photo_url TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  vendor_notes TEXT,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Create indexes
CREATE INDEX idx_rebates_customer ON rebates(customer_id);
CREATE INDEX idx_rebates_status ON rebates(status);
CREATE INDEX idx_rebates_machine ON rebates(machine_id);
CREATE INDEX idx_rebates_submitted ON rebates(submitted_at);
