-- Create pods table
CREATE TABLE IF NOT EXISTS pods (
  id VARCHAR(24) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL,
  created_by VARCHAR(24) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create pod_members table for many-to-many relationship
CREATE TABLE IF NOT EXISTS pod_members (
  id SERIAL PRIMARY KEY,
  pod_id VARCHAR(24) REFERENCES pods(id) ON DELETE CASCADE,
  user_id VARCHAR(24) NOT NULL,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pod_id, user_id)
);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  pod_id VARCHAR(24) REFERENCES pods(id) ON DELETE CASCADE,
  user_id VARCHAR(24) NOT NULL,
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text' NOT NULL,
  reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  -- Threading (W-T, TASK-029). DELIBERATELY separate from reply_to_message_id,
  -- which is an ADDRESSING edge: it feeds `isRouted` and the implicit-reply
  -- chat.mention (agentMentionService :1025 / :1356), so a human replying to an
  -- agent addresses that agent. If thread membership rode the same column,
  -- joining a thread would ping the parent's author — the opposite of what
  -- ambient scoping is for (fable's #1045 ruling). thread_root_id carries no
  -- addressing. NULL means "not in a thread"; a root is an ordinary message
  -- other messages point at, and a root's own thread_root_id stays NULL.
  thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create users table for storing MongoDB user references
CREATE TABLE IF NOT EXISTS users (
  _id VARCHAR(24) PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  profile_picture TEXT,
  is_bot BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Migration: add is_bot column to existing tables (safe to run repeatedly)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;

-- ADR-020 D3: structured message payload (approval cards and future
-- server-defined message components). Self-applies at boot, same pattern
-- as is_bot above. NULL for ordinary messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS payload JSONB;

-- Migration records. There was no such table anywhere under backend/ before
-- this (@sprint-review, 56859, checked with a positive control): schema.sql is
-- idempotent boot DDL, which says what the shape IS and never when it changed.
-- That is fine until a RULE needs to reference the change — the threading
-- surface ruling (#1115) says pre-cutoff thread roots default to expanded,
-- "cutoff = the migration timestamp, read from the migration record", and that
-- record did not exist.
--
-- Deliberately general rather than a threading-specific row. A one-off
-- `threading_migration` table is the thing that has to be generalised the
-- second time someone needs this, and the second time is when it gets done
-- wrong. `details` is JSONB so a migration can record what only IT knew — for
-- the threading backfill, the boundary timestamp it would otherwise discard.
--
-- NOT a migration RUNNER. Nothing reads this to decide what to apply; boot DDL
-- still owns that. It is a ledger, and the distinction matters: a reader must
-- never infer "migration X has not run" from a missing row — it may have run
-- on an instance that predates this table.
CREATE TABLE IF NOT EXISTS migration_records (
  name VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB
);

-- Sprint B5: message reactions. One row per (message, user, emoji) — a user
-- can stack different emojis on the same message but each emoji is binary
-- (toggle on/off). PG-only; Mongo fallback path doesn't get reactions in v1.
CREATE TABLE IF NOT EXISTS message_reactions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id VARCHAR(24) NOT NULL,
  emoji VARCHAR(32) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_pod_id ON messages(pod_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
-- Threading reads are "give me this thread" and "how many replies has it", both
-- keyed on the root. reply_to_message_id has no index, which is why the root is
-- stored rather than walked: deriving it per read is a seq-scan per level.
CREATE INDEX IF NOT EXISTS idx_messages_thread_root_id ON messages(thread_root_id);
CREATE INDEX IF NOT EXISTS idx_pod_members_pod_id ON pod_members(pod_id);
CREATE INDEX IF NOT EXISTS idx_pod_members_user_id ON pod_members(user_id);
CREATE INDEX IF NOT EXISTS idx_pods_created_by ON pods(created_by);
CREATE INDEX IF NOT EXISTS idx_pods_type ON pods(type);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username); 