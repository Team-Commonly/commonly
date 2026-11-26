-- ADR-034 step 2: the Postgres copy of NeedsYouEmail, one needs-you email per
-- attention item (repositories/needsYouEmailRepository.ts). Mongo stays the
-- system of record until the model's mode reaches pg; in dual and pg-read every
-- write is copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id (an ObjectId's hex string). attention_item_id is the
-- ask's id (hex), unique as in Mongo: that unique insert is the claim that
-- keeps an ask from being emailed twice. recipient_user_id is the recipient's
-- user id (hex), indexed for the digest's overflow read. click_token is the
-- secret in the email's link, unique as in Mongo (the model hides it from
-- reads with select: false; the helper still copies it). status is claimed,
-- sent, overflow or failed. sent_at, clicked_at and included_in_digest_at are
-- NULL until set; the last two are only ever set to a time, never to null, so
-- NULL means the Mongo field is missing, which is what $exists tests.
-- created_at and updated_at are the model's timestamps, nullable so that a
-- document written without them still copies. pg_version is the helper's
-- per-document version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS needs_you_emails (
  id TEXT PRIMARY KEY,
  attention_item_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  click_token TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  included_in_digest_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS needs_you_emails_attention_item_id
  ON needs_you_emails (attention_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS needs_you_emails_click_token
  ON needs_you_emails (click_token);

CREATE INDEX IF NOT EXISTS needs_you_emails_recipient_user_id
  ON needs_you_emails (recipient_user_id);
