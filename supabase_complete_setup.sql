-- ============================================================
-- World of ClaudeCraft - Complete Supabase Setup
-- ============================================================
-- Run this SQL in Supabase Dashboard → SQL Editor
-- https://supabase.com/dashboard/project/vagekvcsjacfvoidvzzj/sql
-- ============================================================

-- Step 1: Add game_state column to characters table
ALTER TABLE characters ADD COLUMN IF NOT EXISTS game_state JSONB;

-- Step 2: Enable RLS on all tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends ENABLE ROW LEVEL SECURITY;
ALTER TABLE ignores ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladder ENABLE ROW LEVEL SECURITY;

-- Step 3: Drop existing policies (if any) to avoid conflicts
DROP POLICY IF EXISTS "Allow anon to insert accounts" ON accounts;
DROP POLICY IF EXISTS "Allow anon to read accounts for login" ON accounts;
DROP POLICY IF EXISTS "Allow anon to read characters" ON characters;
DROP POLICY IF EXISTS "Allow anon to insert characters" ON characters;
DROP POLICY IF EXISTS "Allow owner to update characters" ON characters;
DROP POLICY IF EXISTS "Allow owner to delete characters" ON characters;
DROP POLICY IF EXISTS "Allow read friends" ON friends;
DROP POLICY IF EXISTS "Allow insert friends" ON friends;
DROP POLICY IF EXISTS "Allow delete friends" ON friends;
DROP POLICY IF EXISTS "Allow read ignores" ON ignores;
DROP POLICY IF EXISTS "Allow insert ignores" ON ignores;
DROP POLICY IF EXISTS "Allow delete ignores" ON ignores;
DROP POLICY IF EXISTS "Allow anon to read chat" ON chat_logs;
DROP POLICY IF EXISTS "Allow anon to insert chat" ON chat_logs;
DROP POLICY IF EXISTS "Allow anon to read ladder" ON ladder;
DROP POLICY IF EXISTS "Allow insert to ladder" ON ladder;
DROP POLICY IF EXISTS "Allow update ladder" ON ladder;

-- Step 4: Create RLS policies for accounts table
CREATE POLICY "Allow anon to insert accounts"
  ON accounts FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow anon to read accounts for login"
  ON accounts FOR SELECT
  USING (true);

-- Step 5: Create RLS policies for characters table
CREATE POLICY "Allow anon to read characters"
  ON characters FOR SELECT
  USING (true);

CREATE POLICY "Allow anon to insert characters"
  ON characters FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow owner to update characters"
  ON characters FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow owner to delete characters"
  ON characters FOR DELETE
  USING (true);

-- Step 6: Create RLS policies for friends table
CREATE POLICY "Allow read friends"
  ON friends FOR SELECT
  USING (true);

CREATE POLICY "Allow insert friends"
  ON friends FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow delete friends"
  ON friends FOR DELETE
  USING (true);

-- Step 7: Create RLS policies for ignores table
CREATE POLICY "Allow read ignores"
  ON ignores FOR SELECT
  USING (true);

CREATE POLICY "Allow insert ignores"
  ON ignores FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow delete ignores"
  ON ignores FOR DELETE
  USING (true);

-- Step 8: Create RLS policies for chat_logs table
CREATE POLICY "Allow anon to read chat"
  ON chat_logs FOR SELECT
  USING (true);

CREATE POLICY "Allow anon to insert chat"
  ON chat_logs FOR INSERT
  WITH CHECK (true);

-- Step 9: Create RLS policies for ladder table
CREATE POLICY "Allow anon to read ladder"
  ON ladder FOR SELECT
  USING (true);

CREATE POLICY "Allow insert to ladder"
  ON ladder FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow update ladder"
  ON ladder FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- Setup complete!
-- ============================================================
-- Verify with:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
-- ============================================================
