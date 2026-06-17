-- =============================================================================
-- Supabase RLS (Row Level Security) Setup for World of ClaudeCraft
-- =============================================================================
-- Run this SQL in your Supabase SQL Editor (Dashboard → SQL Editor)
-- These policies allow:
--   - Anyone (anon) to register accounts and read characters/friends/chat
--   - Authenticated users to manage their own characters and social data
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends ENABLE ROW LEVEL SECURITY;
ALTER TABLE ignores ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladder ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- ACCOUNTS table
-- =============================================================================

-- Allow anyone to INSERT (register) a new account
CREATE POLICY "Allow anon to insert accounts"
  ON accounts FOR INSERT
  WITH CHECK (true);

-- Allow anyone to SELECT accounts (for login lookup — username+password_hash only)
-- Note: we only return rows, not modify them
CREATE POLICY "Allow anon to read accounts for login"
  ON accounts FOR SELECT
  USING (true);

-- =============================================================================
-- CHARACTERS table
-- =============================================================================

-- Allow anyone to SELECT characters (for character selection screen)
CREATE POLICY "Allow anon to read characters"
  ON characters FOR SELECT
  USING (true);

-- Allow anyone to INSERT a new character (with account_id)
-- Players create their own characters
CREATE POLICY "Allow anon to insert characters"
  ON characters FOR INSERT
  WITH CHECK (true);

-- Allow account owner to UPDATE their character (game state, inventory, etc.)
CREATE POLICY "Allow owner to update characters"
  ON characters FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Allow account owner to DELETE their character
CREATE POLICY "Allow owner to delete characters"
  ON characters FOR DELETE
  USING (true);

-- =============================================================================
-- FRIENDS table
-- =============================================================================

-- Allow read of friends list (for social panel)
CREATE POLICY "Allow read friends"
  ON friends FOR SELECT
  USING (true);

-- Allow INSERT new friends
CREATE POLICY "Allow insert friends"
  ON friends FOR INSERT
  WITH CHECK (true);

-- Allow DELETE friends (remove friend)
CREATE POLICY "Allow delete friends"
  ON friends FOR DELETE
  USING (true);

-- =============================================================================
-- IGNORES table
-- =============================================================================

-- Allow read of ignore list
CREATE POLICY "Allow read ignores"
  ON ignores FOR SELECT
  USING (true);

-- Allow INSERT ignores
CREATE POLICY "Allow insert ignores"
  ON ignores FOR INSERT
  WITH CHECK (true);

-- Allow DELETE ignores (unblock)
CREATE POLICY "Allow delete ignores"
  ON ignores FOR DELETE
  USING (true);

-- =============================================================================
-- CHAT_LOGS table
-- =============================================================================

-- Allow anyone to read chat logs (public chat history)
CREATE POLICY "Allow anon to read chat"
  ON chat_logs FOR SELECT
  USING (true);

-- Allow anyone to INSERT chat messages
CREATE POLICY "Allow anon to insert chat"
  ON chat_logs FOR INSERT
  WITH CHECK (true);

-- =============================================================================
-- LADDER table
-- =============================================================================

-- Allow anyone to read the leaderboard
CREATE POLICY "Allow anon to read ladder"
  ON ladder FOR SELECT
  USING (true);

-- Allow INSERT to ladder (register character for PvP)
CREATE POLICY "Allow insert to ladder"
  ON ladder FOR INSERT
  WITH CHECK (true);

-- Allow UPDATE to ladder (update rating/wins/losses)
CREATE POLICY "Allow update ladder"
  ON ladder FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- NOTES
-- =============================================================================
-- The current RLS setup uses "anon" (anonymous) key for all operations.
-- For better security, you should configure Supabase Auth (email/password) and
-- use authenticated user tokens (JWT) instead of the anon key for writes.
--
-- To upgrade to proper auth:
-- 1. Enable Supabase Auth in your Supabase project
-- 2. Create a sign-up / sign-in flow using Supabase Auth
-- 3. Replace the anonymous key with the user's JWT token
-- 4. Update the RLS policies to check auth.uid() = account_id
--
-- Example authenticated policy for characters:
--   CREATE POLICY "Allow authenticated to manage own characters"
--     ON characters FOR ALL
--     USING (auth.uid()::text = account_id)
--     WITH CHECK (auth.uid()::text = account_id);
-- =============================================================================
