-- ADR-034 step 2: the Postgres copy of DiscordSummaryHistory, the record of each
-- Discord summary queued for Commonly Bot
-- (repositories/discordSummaryHistoryRepository.ts). Mongo stays the system of
-- record until the model's mode reaches pg; in dual and pg-read every write is
-- copied here by the dual-store helper (repositories/dualStore.ts). The model is
-- insert-only: each summary is one row, written once.
--
-- id is the Mongo _id (an ObjectId's hex string). integration_id is the
-- Integration's id (hex). summary_type is hourly, daily or manual. content is
-- the summary text and message_count the number of messages it covers.
-- time_range is the embedded { start, end } as JSON with ISO strings.
-- posted_to_discord and posted_to_commonly are the two flags, and created_at and
-- updated_at the model's timestamps. The flags and timestamps are nullable so
-- that a document written without them still copies. pg_version is the
-- helper's per-document version: a copy applies only above the stored one.
--
-- Mongo's index on the embedded timeRange compares whole subdocuments and
-- nothing queries it, so it has no counterpart here.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS discord_summary_histories (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  summary_type TEXT NOT NULL,
  content TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  time_range JSONB NOT NULL,
  posted_to_discord BOOLEAN,
  posted_to_commonly BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS discord_summary_histories_integration_created
  ON discord_summary_histories (integration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS discord_summary_histories_summary_type
  ON discord_summary_histories (summary_type);
