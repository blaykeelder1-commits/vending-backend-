-- Add qr_token column to vending_machines table
ALTER TABLE vending_machines ADD COLUMN IF NOT EXISTS qr_token UUID UNIQUE;

-- Create index on qr_token
CREATE INDEX IF NOT EXISTS idx_machines_qr_token ON vending_machines(qr_token);

-- Generate qr_token for existing machines
UPDATE vending_machines SET qr_token = gen_random_uuid() WHERE qr_token IS NULL;
