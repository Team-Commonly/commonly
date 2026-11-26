-- ADR-034 step 2: the Postgres copy of HostedMcpDcrRegistration, one
-- vendor-issued OAuth client (Dynamic Client Registration) for this instance
-- and a hosted-MCP catalogue entry
-- (repositories/hostedMcpDcrRegistrationRepository.ts). Mongo stays the system
-- of record until the model's mode reaches pg; in dual and pg-read every write
-- is copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id (hex). client_id is the vendor's public client
-- identifier. client_secret_ref is a reference, never a secret: the _id (hex)
-- of the connector_secrets document that holds a confidential client's secret
-- encrypted (services/connectorSecrets.ts), NULL for a public client. No
-- registration_access_token exists to copy. client_secret_expires_at is when
-- the vendor said the secret lapses (NULL: never). current marks the client
-- new starts get; retired_at, refused_at and asked_at are NULL until set.
-- Every column but id is nullable, so a document written before a field
-- existed still copies. created_at and updated_at are the model's timestamps.
-- pg_version is the helper's per-document version: a copy applies only above
-- the stored one.
--
-- The two unique indexes are Mongo's: one current client per entry and issuer
-- (partial, as Mongo's partialFilterExpression { current: true }), and one row
-- per entry, issuer and client. Mongo has no TTL index on this collection, so
-- neither has Postgres: a lapsing secret is judged from
-- client_secret_expires_at by the code, and no row expires on its own.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS hosted_mcp_dcr_registrations (
  id TEXT PRIMARY KEY,
  entry_id TEXT,
  issuer TEXT,
  client_id TEXT,
  redirect_uri TEXT,
  token_endpoint_auth_method TEXT,
  client_secret_ref TEXT,
  client_secret_expires_at TIMESTAMPTZ,
  current BOOLEAN,
  retired_at TIMESTAMPTZ,
  refused_at TIMESTAMPTZ,
  asked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS hosted_mcp_dcr_registrations_current
  ON hosted_mcp_dcr_registrations (entry_id, issuer) WHERE current;

CREATE UNIQUE INDEX IF NOT EXISTS hosted_mcp_dcr_registrations_client
  ON hosted_mcp_dcr_registrations (entry_id, issuer, client_id);
