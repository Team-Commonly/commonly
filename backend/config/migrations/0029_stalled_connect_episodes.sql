-- ADR-034 step 2: the Postgres copy of StalledConnectEpisode, the record that
-- a seat was installed and its newest runtime token never used, behind the
-- stalled-connect nudge, its resolution post, and the installer's digest and
-- waiting-owner email lines (repositories/stalledConnectEpisodeRepository.ts).
-- Mongo stays the system of record until the model's mode reaches pg; in dual
-- and pg-read every write is copied here by the dual-store helper
-- (repositories/dualStore.ts).
--
-- id is the Mongo _id (hex). installation_id (the AgentInstallation) and
-- installed_by (the installer's User) are ObjectIds held as hex text.
-- installer_username is the installer's handle, as Mongo holds it. pod_id,
-- agent_name, instance_id and display_name name the seat. token_issued_at is
-- the issue time of the token that defines the episode; token_source is
-- installation, user or NULL; producer is timer or reactive. nudged_at is when
-- the episode opened; nudge_message_id and resolution_message_id are message
-- ids (a Postgres message's integer id or a Mongo message's hex _id, as text).
-- resolved_at, digested_at and digested_again_at are NULL until set; status is
-- open or resolved. created_at and updated_at are the model's timestamps. Every
-- column but id, installation_id and token_issued_at is nullable, so a document
-- written before a field existed still copies. pg_version is the helper's
-- per-document version: a copy applies only above the stored one.
--
-- The unique (installation_id, token_issued_at) mirrors Mongo's: it is the
-- one-nudge-per-token-episode rule. In mongo, dual and pg-read the lock is
-- Mongo's index, which refuses a duplicate before any copy, so this one only
-- refuses a copy that would make Postgres disagree with Mongo. Mongo has three
-- other indexes, all plain. Two are kept here: (status, nudged_at) for the
-- digest's open-by-age read and (installed_by, status) for one installer's
-- open episodes. The third, (status, _id), serves the resolution sweep's pages
-- of open episodes in _id order; it is left out because id is the primary key,
-- so a step-4 sweep can walk it and filter status, and every read stays on
-- Mongo until pg (these serve step 4). Mongo has no TTL index, so neither has Postgres, and no
-- caller deletes an episode.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS stalled_connect_episodes (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  pod_id TEXT,
  installed_by TEXT,
  installer_username TEXT,
  agent_name TEXT,
  instance_id TEXT,
  display_name TEXT,
  token_issued_at TIMESTAMPTZ NOT NULL,
  token_source TEXT,
  producer TEXT,
  nudged_at TIMESTAMPTZ,
  nudge_message_id TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_message_id TEXT,
  digested_at TIMESTAMPTZ,
  digested_again_at TIMESTAMPTZ,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS stalled_connect_episodes_installation_token
  ON stalled_connect_episodes (installation_id, token_issued_at);

CREATE INDEX IF NOT EXISTS stalled_connect_episodes_status_nudged_at
  ON stalled_connect_episodes (status, nudged_at);

CREATE INDEX IF NOT EXISTS stalled_connect_episodes_installed_by_status
  ON stalled_connect_episodes (installed_by, status);
