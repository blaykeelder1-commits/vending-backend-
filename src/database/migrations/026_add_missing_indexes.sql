-- Migration: Add missing database indexes for performance
-- Purpose: Improve query performance on frequently accessed columns

-- Index on poll_votes.session_id for duplicate vote checking
CREATE INDEX IF NOT EXISTS idx_poll_votes_session_id ON poll_votes(session_id);

-- Composite index on machine_products for inventory lookups
CREATE INDEX IF NOT EXISTS idx_machine_products_machine_product ON machine_products(machine_id, product_id);

-- Index on customer_sessions.session_token for session lookups
CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions(session_token);

-- Index on customer_sessions.machine_id for machine-based session queries
CREATE INDEX IF NOT EXISTS idx_customer_sessions_machine_id ON customer_sessions(machine_id);

-- Index on polls.machine_id for machine poll lookups
CREATE INDEX IF NOT EXISTS idx_polls_machine_id ON polls(machine_id);

-- Index on poll_options.poll_id for option lookups
CREATE INDEX IF NOT EXISTS idx_poll_options_poll_id ON poll_options(poll_id);

-- Index on product_suggestions.machine_id for suggestion queries
CREATE INDEX IF NOT EXISTS idx_product_suggestions_machine_id ON product_suggestions(machine_id);

-- Index on performance_history for performance tracking (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'performance_history') THEN
    CREATE INDEX IF NOT EXISTS idx_performance_history_inventory_id ON performance_history(machine_product_id);
  END IF;
END $$;

-- Index on redistribution_history (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'redistribution_history') THEN
    CREATE INDEX IF NOT EXISTS idx_redistribution_history_vendor_id ON redistribution_history(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_redistribution_history_source_machine ON redistribution_history(source_machine_id);
    CREATE INDEX IF NOT EXISTS idx_redistribution_history_target_machine ON redistribution_history(target_machine_id);
  END IF;
END $$;

-- Analyze tables to update statistics after adding indexes
ANALYZE poll_votes;
ANALYZE machine_products;
ANALYZE customer_sessions;
ANALYZE polls;
ANALYZE poll_options;
ANALYZE product_suggestions;
