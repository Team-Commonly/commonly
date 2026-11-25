-- ADR-034 step 2: the Postgres copy of NeedsYouEmailQuota, the per-recipient
-- daily cap on needs-you emails (repositories/needsYouEmailQuotaRepository.ts).
-- Mongo stays the system of record until the model's mode reaches pg; in dual
-- and pg-read every write is copied here by the dual-store helper
-- (repositories/dualStore.ts).
--
-- id is the Mongo _id (an ObjectId's hex string). recipient_user_id is the
-- recipient's user id (hex), and day the UTC day as YYYY-MM-DD text, as Mongo
-- stores it. The pair is unique, as in Mongo: it is what a claim matches on.
-- count is the slots taken that day. pg_version is the helper's per-document
-- version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS needs_you_email_quotas (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS needs_you_email_quotas_recipient_day
  ON needs_you_email_quotas (recipient_user_id, day);
