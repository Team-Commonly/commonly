-- ADR-034 step 2: the Postgres copy of WaitlistRequest, one person's request
-- to join the instance, reviewed by a global admin
-- (repositories/waitlistRequestRepository.ts). Mongo stays the system of
-- record until the model's mode reaches pg; in dual and pg-read every write is
-- copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id (hex). email (lowercased and trimmed by the schema),
-- name, organization, use_case and note are what the person typed into the
-- waitlist form: personal data, the same fields Mongo holds. status is
-- pending, invited or closed. invitation_code is a reference, never a code:
-- the _id (hex) of the invitation_codes document the admin sent, NULL until
-- an invitation goes out and again after a close. invited_by is the admin's
-- User _id (hex). invited_at and invitation_sent_at are NULL until an
-- invitation goes out and again after a close. Every column but id is
-- nullable, so a document written before a field existed still copies.
-- created_at and updated_at are the model's timestamps. pg_version is the
-- helper's per-document version: a copy applies only above the stored one.
--
-- Mongo has no unique index on this collection besides _id (a person may
-- ask again once a request is closed or invited), so neither has Postgres.
-- Its other indexes (email, status, createdAt) are plain, and the two kept
-- here serve the pending-request lookup and the newest-first admin list. Mongo
-- has no TTL index, so neither has Postgres: no request expires on its own.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS waitlist_requests (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  organization TEXT,
  use_case TEXT,
  note TEXT,
  status TEXT,
  invitation_code TEXT,
  invited_at TIMESTAMPTZ,
  invitation_sent_at TIMESTAMPTZ,
  invited_by TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS waitlist_requests_email_status
  ON waitlist_requests (email, status);

CREATE INDEX IF NOT EXISTS waitlist_requests_created_at
  ON waitlist_requests (created_at DESC);
