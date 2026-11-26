-- ADR-034 step 2: the Postgres copy of AgentComputerTakeover, a person's
-- takeover of an agent's computer and the browser target bound to it
-- (repositories/agentComputerTakeoverRepository.ts). Mongo stays the system of
-- record until the model's mode reaches pg; in dual and pg-read every write is
-- copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id: the AgentInstallation id (hex). owner_id is the owning
-- user's id (hex); every read and write is keyed by it. active is whether the
-- takeover is on. target_id is the bound browser target, NULL until one is
-- bound. created_at and updated_at are nullable so that a document written
-- without timestamps still copies. pg_version is the helper's per-document
-- version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_computer_takeovers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  target_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_computer_takeovers_owner_id
  ON agent_computer_takeovers (owner_id);
