-- ADR-034 step 2: the Postgres copy of AgentPodReadCursor, an agent's read
-- watermark in a pod (repositories/agentPodReadCursorRepository.ts). Mongo stays
-- the system of record until the model's mode reaches pg; in dual and pg-read
-- every write is copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id, the deterministic "agentUserId:podId" string. pg_version
-- is the helper's per-document version: a copy applies only above the stored
-- one, so a late write never overwrites a newer row. Reads are by primary key
-- only (getReadWatermark), and the backfill/verify scan pages by id, so no
-- secondary index is needed. read_revision is BIGINT like its source,
-- pod_message_revisions.revision.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_pod_read_cursors (
  id TEXT PRIMARY KEY,
  agent_user_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  read_revision BIGINT,
  pg_version INTEGER NOT NULL
);
