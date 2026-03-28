-- Machine Notes Log
-- Migration: 038_create_machine_notes.sql
-- Stores individual note entries per machine (replaces single notes field)

CREATE TABLE IF NOT EXISTS machine_notes (
  id SERIAL PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES vending_machines(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for fetching notes by machine, newest first
CREATE INDEX IF NOT EXISTS idx_machine_notes_machine_time
  ON machine_notes(machine_id, created_at DESC);

COMMENT ON TABLE machine_notes IS 'Log of vendor notes for each machine, ordered by creation time';
