-- Migration: Add poll_type and is_auto_generated to polls table
-- Purpose: Support auto-generated performance polls and vendor-created discovery polls

-- Add poll_type column: 'performance' (auto-generated from underperformers) or 'discovery' (vendor-created for new products)
ALTER TABLE polls
ADD COLUMN IF NOT EXISTS poll_type VARCHAR(20) DEFAULT 'performance' CHECK (poll_type IN ('performance', 'discovery'));

-- Add is_auto_generated flag to distinguish auto-generated polls from vendor-created ones
ALTER TABLE polls
ADD COLUMN IF NOT EXISTS is_auto_generated BOOLEAN DEFAULT FALSE;

-- Add index for efficient querying by poll type
CREATE INDEX IF NOT EXISTS idx_polls_poll_type ON polls(poll_type);
CREATE INDEX IF NOT EXISTS idx_polls_is_auto_generated ON polls(is_auto_generated);

-- Update existing polls to be 'performance' type (they were manually created, so is_auto_generated stays false)
UPDATE polls SET poll_type = 'performance' WHERE poll_type IS NULL;

COMMENT ON COLUMN polls.poll_type IS 'Type of poll: performance (for underperforming products) or discovery (for testing new products)';
COMMENT ON COLUMN polls.is_auto_generated IS 'Whether this poll was auto-generated when customer scanned QR with no active poll';
