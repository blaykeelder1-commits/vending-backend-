-- Create polls table
CREATE TABLE IF NOT EXISTS polls (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id INTEGER REFERENCES vending_machines(id) ON DELETE CASCADE,
  poll_question TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_polls_vendor ON polls(vendor_id);
CREATE INDEX idx_polls_machine ON polls(machine_id);
CREATE INDEX idx_polls_active ON polls(is_active);
CREATE INDEX idx_polls_created ON polls(created_at);

-- Create trigger to update updated_at timestamp
CREATE TRIGGER update_polls_updated_at BEFORE UPDATE ON polls
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
