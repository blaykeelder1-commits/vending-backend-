-- Create loyalty_points table
CREATE TABLE IF NOT EXISTS loyalty_points (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  rebate_id INTEGER REFERENCES rebates(id) ON DELETE SET NULL,
  points_earned INTEGER NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_loyalty_customer ON loyalty_points(customer_id);
CREATE INDEX idx_loyalty_machine ON loyalty_points(machine_id);
CREATE INDEX idx_loyalty_rebate ON loyalty_points(rebate_id);
CREATE INDEX idx_loyalty_created ON loyalty_points(created_at);

-- Create view for customer total points
CREATE OR REPLACE VIEW customer_loyalty_totals AS
SELECT
  customer_id,
  SUM(points_earned) as total_points,
  COUNT(*) as transaction_count,
  MAX(created_at) as last_activity
FROM loyalty_points
GROUP BY customer_id;
