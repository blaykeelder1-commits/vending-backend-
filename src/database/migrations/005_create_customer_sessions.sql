-- Create customer_sessions table for QR-based authentication
CREATE TABLE IF NOT EXISTS customer_sessions (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  qr_code_scanned VARCHAR(500) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_sessions_token ON customer_sessions(session_token);
CREATE INDEX idx_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX idx_sessions_machine ON customer_sessions(machine_id);
CREATE INDEX idx_sessions_expires ON customer_sessions(expires_at);
