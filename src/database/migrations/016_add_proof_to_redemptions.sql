-- Add proof of purchase and status tracking to discount_redemptions
ALTER TABLE discount_redemptions
ADD COLUMN IF NOT EXISTS proof_image_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
ADD COLUMN IF NOT EXISTS points_awarded INTEGER DEFAULT 0;

-- Add index on status for filtering
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON discount_redemptions(status);
