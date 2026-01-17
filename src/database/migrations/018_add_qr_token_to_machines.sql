-- Add qr_token column to machines for public-safe QR codes
ALTER TABLE vending_machines ADD COLUMN IF NOT EXISTS qr_token UUID;

-- Create unique index on qr_token
CREATE UNIQUE INDEX IF NOT EXISTS idx_machines_qr_token ON vending_machines(qr_token) WHERE qr_token IS NOT NULL;

-- Generate tokens for existing machines
UPDATE vending_machines SET qr_token = gen_random_uuid() WHERE qr_token IS NULL;

-- Make qr_token not null going forward (after backfilling) - idempotent version
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vending_machines'
    AND column_name = 'qr_token'
    AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE vending_machines ALTER COLUMN qr_token SET NOT NULL;
  END IF;
END $$;
