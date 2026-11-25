-- ADR-034 step 2: the Postgres copy of AgentTaskWakeState, the per-seat
-- throttle on assigned-task wakes (repositories/agentTaskWakeStateRepository.ts).
-- Mongo stays the system of record until the model's mode reaches pg; in dual
-- and pg-read every write is copied here by the dual-store helper
-- (repositories/dualStore.ts).
--
-- id is the Mongo _id: the seat key, a JSON array of the agent name and
-- instance id. last_wake_at is nullable: releasing a slot unsets it, and the
-- document (and its row) stays. created_at and updated_at are nullable so that
-- a document written without timestamps still copies. pg_version is the
-- helper's per-document version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_task_wake_states (
  id TEXT PRIMARY KEY,
  last_wake_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);
