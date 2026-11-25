-- ADR-034 step 2: the Postgres copy of AgentDigestState, the per-seat count of
-- unread ambient events folded out of the AgentEvent retention window
-- (repositories/agentDigestStateRepository.ts). Mongo stays the system of
-- record until the model's mode reaches pg; in dual and pg-read every write is
-- copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id (an ObjectId's hex string). The natural key
-- (agent_name, instance_id, pod_id) is unique, as in Mongo: the fold creates
-- one row per seat and pod. (unread_count, unread_since) serves the scheduler's
-- unread-digest wake scan, as the Mongo index does. conversations and
-- last_event_ids are JSON arrays. folded_through_id is the fold's cursor (an
-- AgentEvent id) and is null before the first fold. unread_since is null while
-- nothing is unread. created_at and updated_at are nullable so that a document
-- written without timestamps still copies. pg_version is the helper's
-- per-document version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_digest_states (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  last_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  conversations JSONB NOT NULL DEFAULT '[]'::jsonb,
  other_count INTEGER NOT NULL DEFAULT 0,
  unread_since TIMESTAMPTZ,
  folded_through_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_digest_states_scope
  ON agent_digest_states (agent_name, instance_id, pod_id);

CREATE INDEX IF NOT EXISTS agent_digest_states_unread
  ON agent_digest_states (unread_count, unread_since);
