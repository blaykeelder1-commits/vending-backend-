-- Add soft delete columns to vending_machines
ALTER TABLE vending_machines ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
ALTER TABLE vending_machines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Add soft delete columns to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Add soft delete columns to machine_products
ALTER TABLE machine_products ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
ALTER TABLE machine_products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Index for efficient filtering of active records
CREATE INDEX IF NOT EXISTS idx_vending_machines_not_deleted ON vending_machines (vendor_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_products_not_deleted ON products (vendor_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_machine_products_not_deleted ON machine_products (machine_id) WHERE is_deleted = false;
