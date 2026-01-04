-- Create poll_votes table
CREATE TABLE IF NOT EXISTS poll_votes (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  poll_option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES customer_sessions(id) ON DELETE SET NULL,
  vote_type VARCHAR(10) NOT NULL CHECK (vote_type IN ('like', 'dislike')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_customer_vote UNIQUE(poll_id, customer_id),
  CONSTRAINT unique_session_vote UNIQUE(poll_id, session_id)
);

-- Create indexes
CREATE INDEX idx_votes_poll ON poll_votes(poll_id);
CREATE INDEX idx_votes_option ON poll_votes(poll_option_id);
CREATE INDEX idx_votes_customer ON poll_votes(customer_id);
CREATE INDEX idx_votes_session ON poll_votes(session_id);

-- Create view for poll results
CREATE OR REPLACE VIEW poll_results AS
SELECT
  po.poll_id,
  po.id as option_id,
  po.option_text,
  po.product_id,
  COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) as likes,
  COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END) as dislikes,
  COUNT(*) as total_votes
FROM poll_options po
LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
GROUP BY po.poll_id, po.id, po.option_text, po.product_id;
