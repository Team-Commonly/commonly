-- ADR-034 step 2: the Postgres copy of AgentFirstContact, the durable record
-- that a person and an agent have met (repositories/agentFirstContactRepository.ts).
-- Mongo stays the system of record until the model's mode reaches pg; in dual
-- and pg-read every write is copied here by the dual-store helper
-- (repositories/dualStore.ts).
--
-- id is the Mongo _id (an ObjectId's hex string). The natural key
-- (user_id, agent_name, instance_id) is unique, as in Mongo: it is what the
-- first-contact claim matches on. greeted_at_by_pod maps a pod id to the date
-- of the last hosted greeting claimed there. created_at is nullable so that a
-- document written without the timestamp still copies. pg_version is the
-- helper's per-document version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_first_contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  first_pod_id TEXT NOT NULL,
  greeted_at_by_pod JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_first_contacts_identity
  ON agent_first_contacts (user_id, agent_name, instance_id);
