-- Cancel feedback for retention analysis
CREATE TABLE IF NOT EXISTS cancel_feedback (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reasons TEXT[] NOT NULL,
  other_text TEXT,
  offered_retention BOOLEAN DEFAULT false,
  accepted_retention BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cancel_feedback_user ON cancel_feedback(user_id);
