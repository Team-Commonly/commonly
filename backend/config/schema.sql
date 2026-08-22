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
-- Per-user, per-thread state (W-T, TASK-029). ONE record carrying both
-- booleans, per ux-lead's ruling in docs/design/threading-surface-ruling.md
-- ("One state record, two booleans"): persisted collapse and follow share the
-- key (user, pod, thread root), so two tables would mean two writes for one
-- gesture. The collapsed column is here at birth rather than in the render PR.
--
-- NOT a widened User.followedThreads: that field is typed
-- `postId: ObjectId ref 'Post', required` and cannot hold a Postgres
-- messages.id. Widening it would silently drop chat rows from every consumer
-- doing Post.find({_id: {$in: postIds}}) -- postController 457/513/548,
-- activityService 614/712, ActivityFeedPage 584.
--
-- A row means "this user has non-default state on this thread". Row PRESENCE
-- carries no meaning on its own, which is why `following` is a column and not
-- row-existence: `collapsed` writes create rows for users who are not
-- following, and if presence meant following, expanding a thread would
-- subscribe you to it.
CREATE TABLE IF NOT EXISTS thread_user_state (
  id SERIAL PRIMARY KEY,
  thread_root_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  pod_id VARCHAR(255) NOT NULL,
  -- TRI-STATE, deliberately nullable. NULL = "no explicit choice, defer to the
  -- participation default" (posted in the thread or was @-mentioned => following).
  -- TRUE = explicitly followed. FALSE = explicitly unfollowed, which for a
  -- participant is a MUTE and must outrank the participation default.
  -- A NOT NULL DEFAULT false here would be a live bug: a collapse-only row
  -- would silently unfollow a participant who had never touched the toggle.
  following BOOLEAN,
  -- Defaults TRUE for everyone including followers -- following never implies
  -- expanded. Only the expand/collapse gesture writes it.
  collapsed BOOLEAN NOT NULL DEFAULT TRUE,
  followed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (thread_root_id, user_id)
);
-- The wake path asks "who follows this thread" on every threaded reply, so the
-- root is the hot key. The user index serves the per-pod render read.
CREATE INDEX IF NOT EXISTS idx_thread_user_state_root ON thread_user_state(thread_root_id);
CREATE INDEX IF NOT EXISTS idx_thread_user_state_user_pod ON thread_user_state(user_id, pod_id);

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