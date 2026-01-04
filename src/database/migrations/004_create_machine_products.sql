-- Create machine_products table (inventory per machine)
CREATE TABLE IF NOT EXISTS machine_products (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  current_stock INTEGER DEFAULT 0 CHECK (current_stock >= 0),
  min_stock_threshold INTEGER DEFAULT 5 CHECK (min_stock_threshold >= 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(machine_id, product_id)
);

-- Create indexes
CREATE INDEX idx_machine_products_machine ON machine_products(machine_id);
CREATE INDEX idx_machine_products_product ON machine_products(product_id);

-- Create trigger to update updated_at timestamp
CREATE TRIGGER update_machine_products_updated_at BEFORE UPDATE ON machine_products
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
