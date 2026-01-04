-- Create vending_machines table
CREATE TABLE IF NOT EXISTS vending_machines (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_name VARCHAR(255) NOT NULL,
  location VARCHAR(500),
  qr_code_data TEXT UNIQUE NOT NULL,
  qr_code_image_url TEXT,
  google_sheet_id VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_machines_vendor ON vending_machines(vendor_id);
CREATE INDEX idx_machines_qr ON vending_machines(qr_code_data);
CREATE INDEX idx_machines_active ON vending_machines(is_active);

-- Create trigger to update updated_at timestamp
CREATE TRIGGER update_vending_machines_updated_at BEFORE UPDATE ON vending_machines
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
