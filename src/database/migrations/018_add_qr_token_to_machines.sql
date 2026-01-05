-- Add qr_token column to machines for public-safe QR codes
ALTER TABLE vending_machines ADD COLUMN IF NOT EXISTS qr_token UUID;

-- Create unique index on qr_token
CREATE UNIQUE INDEX IF NOT EXISTS idx_machines_qr_token ON vending_machines(qr_token) WHERE qr_token IS NOT NULL;

-- Generate tokens for existing machines
UPDATE vending_machines SET qr_token = gen_random_uuid() WHERE qr_token IS NULL;

-- Make qr_token not null going forward (after backfilling)
ALTER TABLE vending_machines ALTER COLUMN qr_token SET NOT NULL;
