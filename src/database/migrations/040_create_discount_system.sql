-- Migration 040: Discount/Rebate System
-- Creates tables for machine discounts, customer accounts, redemptions, and vendor rebate balances

-- Discount definitions (vendor sets these per machine)
CREATE TABLE IF NOT EXISTS machine_discounts (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id),
  vendor_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER REFERENCES products(id), -- NULL means "any product"
  discount_type VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC(5,2) NOT NULL, -- e.g., 10 for 10% or 0.50 for $0.50 off
  max_discount_amount NUMERIC(5,2) DEFAULT 1.00, -- cap for percent discounts
  is_active BOOLEAN DEFAULT true,
  is_brand_sponsored BOOLEAN DEFAULT false, -- true if a brand funds this discount
  brand_name VARCHAR(100), -- e.g., 'Coca-Cola' - the brand paying for this promotion
  brand_funded_per_redemption NUMERIC(5,2) DEFAULT 0, -- what the brand pays IDDI per redemption
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enforce max 3 active discounts per machine (use a trigger or app-level check)
CREATE INDEX IF NOT EXISTS idx_machine_discounts_machine ON machine_discounts(machine_id, is_active);
CREATE INDEX IF NOT EXISTS idx_machine_discounts_vendor ON machine_discounts(vendor_id);

-- Customer accounts (linked to QR scans)
CREATE TABLE IF NOT EXISTS discount_customers (
  id SERIAL PRIMARY KEY,
  phone_or_email VARCHAR(255) UNIQUE NOT NULL, -- unique identifier
  display_name VARCHAR(100),
  zelle_id VARCHAR(255), -- Zelle phone/email for payouts
  card_last_four VARCHAR(4), -- last 4 of linked card (for display only)
  payout_method VARCHAR(20) DEFAULT 'zelle' CHECK (payout_method IN ('zelle', 'card')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discount_customers_phone ON discount_customers(phone_or_email);

-- Discount redemptions (the queue)
CREATE TABLE IF NOT EXISTS discount_redemptions (
  id SERIAL PRIMARY KEY,
  discount_id INTEGER NOT NULL REFERENCES machine_discounts(id),
  customer_id INTEGER NOT NULL REFERENCES discount_customers(id),
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id),
  product_name VARCHAR(255) NOT NULL,
  purchase_price NUMERIC(5,2) NOT NULL DEFAULT 0,
  rebate_amount NUMERIC(5,2) NOT NULL DEFAULT 0,
  processing_fee NUMERIC(5,2) NOT NULL DEFAULT 0, -- IDDI's per-transaction markup
  total_vendor_cost NUMERIC(5,2) NOT NULL DEFAULT 0, -- rebate_amount + processing_fee
  proof_image_url TEXT, -- URL to uploaded proof of purchase
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  is_brand_sponsored BOOLEAN DEFAULT false, -- true if a brand funded this discount
  brand_name VARCHAR(100), -- e.g., 'Coca-Cola' if brand-sponsored
  claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP,
  paid_at TIMESTAMP,
  payout_reference VARCHAR(255) -- Zelle transaction ID or reference
);

CREATE INDEX IF NOT EXISTS idx_redemptions_status ON discount_redemptions(status);
CREATE INDEX IF NOT EXISTS idx_redemptions_customer ON discount_redemptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_discount ON discount_redemptions(discount_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_machine ON discount_redemptions(machine_id);

-- Vendor rebate balance (prepaid wallet)
CREATE TABLE IF NOT EXISTS vendor_rebate_balance (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  balance NUMERIC(8,2) DEFAULT 0.00,
  total_loaded NUMERIC(8,2) DEFAULT 0.00,
  total_paid_out NUMERIC(8,2) DEFAULT 0.00,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Balance transactions log
CREATE TABLE IF NOT EXISTS rebate_balance_transactions (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id),
  transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('load', 'payout', 'refund')),
  amount NUMERIC(8,2) NOT NULL,
  balance_before NUMERIC(8,2) NOT NULL,
  balance_after NUMERIC(8,2) NOT NULL,
  reference_id INTEGER, -- links to discount_redemptions.id for payouts
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rebate_balance_txns_vendor ON rebate_balance_transactions(vendor_id);
