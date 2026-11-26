-- ADR-034 step 2: the Postgres copy of AgentTaskRowWakeState, what the
-- assigned-task wake remembers about one row for one seat
-- (repositories/agentTaskRowWakeStateRepository.ts). Mongo stays the system of
-- record until the model's mode reaches pg; in dual and pg-read every write is
-- copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id: `<seat key>|<row _id>`. last_wake_event_id and
-- counted_event_id are AgentEvent ObjectIds as hex strings, NULL for a Mongo
-- null. last_wake_at, stopped_at and last_verdict are NULL until set (and set
-- back to NULL by the wake's own writes). failures is the count of consecutive
-- failed runs. Every column but id is nullable, so a document written before a
-- field existed still copies. created_at and updated_at are the model's
-- timestamps. pg_version is the helper's per-document version: a copy applies
-- only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_task_row_wake_states (
  id TEXT PRIMARY KEY,
  last_wake_at TIMESTAMPTZ,
  last_wake_event_id TEXT,
  counted_event_id TEXT,
  failures INTEGER,
  stopped_at TIMESTAMPTZ,
  last_verdict TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);
