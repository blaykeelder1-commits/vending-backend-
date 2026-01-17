-- Migration: Create referral system and scheduled emails tables

-- Referral codes table
CREATE TABLE IF NOT EXISTS referral_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(20) UNIQUE NOT NULL,
    uses_count INTEGER DEFAULT 0,
    max_uses INTEGER DEFAULT NULL, -- NULL means unlimited
    reward_days INTEGER DEFAULT 14, -- Days of extended trial for referrer
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT NULL
);

-- Referrals tracking table
CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    referred_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    referral_code_id INTEGER REFERENCES referral_codes(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, completed, expired
    reward_granted BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP DEFAULT NULL,
    UNIQUE(referred_id) -- A user can only be referred once
);

-- Scheduled emails table
CREATE TABLE IF NOT EXISTS scheduled_emails (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    template_data JSONB DEFAULT '{}',
    scheduled_for TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed, cancelled
    sent_at TIMESTAMP DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, template_name) -- Prevent duplicate scheduled emails
);

-- Email log for tracking all sent emails
CREATE TABLE IF NOT EXISTS email_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email VARCHAR(255) NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    subject VARCHAR(255),
    status VARCHAR(20) NOT NULL, -- sent, failed
    external_id VARCHAR(255), -- ID from email provider (Resend)
    error_message TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User activity tracking for re-engagement emails
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code_used VARCHAR(20) DEFAULT NULL;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status ON scheduled_emails(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_email_log_user_id ON email_log(user_id);
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);

-- Function to generate unique referral codes
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS VARCHAR(8) AS $$
DECLARE
    chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result VARCHAR(8) := '';
    i INTEGER;
BEGIN
    FOR i IN 1..8 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate referral code for new vendors
CREATE OR REPLACE FUNCTION create_vendor_referral_code()
RETURNS TRIGGER AS $$
DECLARE
    new_code VARCHAR(8);
    code_exists BOOLEAN;
BEGIN
    IF NEW.role = 'vendor' THEN
        LOOP
            new_code := generate_referral_code();
            SELECT EXISTS(SELECT 1 FROM referral_codes WHERE code = new_code) INTO code_exists;
            EXIT WHEN NOT code_exists;
        END LOOP;

        INSERT INTO referral_codes (user_id, code)
        VALUES (NEW.id, new_code);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only create trigger if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'create_referral_code_trigger') THEN
        CREATE TRIGGER create_referral_code_trigger
        AFTER INSERT ON users
        FOR EACH ROW
        EXECUTE FUNCTION create_vendor_referral_code();
    END IF;
END
$$;
