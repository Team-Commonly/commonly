-- ADR-034 step 2: the Postgres copy of AgentProviderKey, the binding of one
-- agent's own model-provider key to its owner and provider destination
-- (repositories/agentProviderKeyRepository.ts). Mongo stays the system of
-- record until the model's mode reaches pg; in dual and pg-read every write is
-- copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id (hex). agent_user_id, owner_user_id and set_by are User
-- ObjectIds as hex strings. secret_ref is a reference, never key material: the
-- _id (hex) of the connector_secrets document that holds the key encrypted
-- (services/connectorSecrets.ts), NULL when no key is set. generation is the
-- set/remove lock every write bumps or matches. set_at, set_by and
-- last_used_at are NULL until set (and set back to NULL by a remove). Every
-- column but id is nullable, so a document written before a field existed
-- still copies. created_at and updated_at are the model's timestamps.
-- pg_version is the helper's per-document version: a copy applies only above
-- the stored one.
--
-- agent_user_id is unique, as Mongo's agentUserId index is.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS agent_provider_keys (
  id TEXT PRIMARY KEY,
  agent_user_id TEXT,
  owner_user_id TEXT,
  provider_id TEXT,
  base_url TEXT,
  generation INTEGER,
  secret_ref TEXT,
  set_at TIMESTAMPTZ,
  set_by TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_provider_keys_agent_user_id
  ON agent_provider_keys (agent_user_id);
