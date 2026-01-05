-- Fix poll_votes constraints for swipe-style voting (vote on each option)
ALTER TABLE poll_votes DROP CONSTRAINT IF EXISTS unique_customer_vote;
ALTER TABLE poll_votes DROP CONSTRAINT IF EXISTS unique_session_vote;

-- Allow one vote per option per customer
ALTER TABLE poll_votes ADD CONSTRAINT unique_customer_option_vote
  UNIQUE(poll_option_id, customer_id)
  WHERE customer_id IS NOT NULL;

ALTER TABLE poll_votes ADD CONSTRAINT unique_session_option_vote
  UNIQUE(poll_option_id, session_id)
  WHERE session_id IS NOT NULL;

-- Update poll_results view to include percentages
DROP VIEW IF EXISTS poll_results;
CREATE OR REPLACE VIEW poll_results AS
SELECT
  po.poll_id,
  po.id as option_id,
  po.option_text,
  po.image_url,
  po.product_id,
  COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) as approve_count,
  COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END) as deny_count,
  COUNT(*) as total_votes,
  CASE
    WHEN COUNT(*) > 0 THEN
      ROUND(100.0 * COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) / COUNT(*), 1)
    ELSE 0
  END as approve_percent
FROM poll_options po
LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
GROUP BY po.poll_id, po.id, po.option_text, po.image_url, po.product_id;
