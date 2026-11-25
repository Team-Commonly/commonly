-- ADR-034 step 2: the Postgres copy of BillingEvent, the Stripe webhook
-- idempotency marker (repositories/billingEventRepository.ts). Mongo stays the
-- system of record until the model's mode reaches pg; in dual and pg-read every
-- write is copied here by the dual-store helper (repositories/dualStore.ts).
--
-- id is the Mongo _id (an ObjectId's hex string). event_id is Stripe's event
-- id, unique as in Mongo: that unique insert is the lock that keeps a retried
-- delivery from being processed twice. type is the event type. customer_id is
-- the Stripe customer and user_id the mapped user's id (hex), both NULL when
-- unknown. outcome is applied, ignored, unmapped or error, and detail its note.
-- created_at is nullable so that a document written without timestamps still
-- copies (the model has no updatedAt). pg_version is the helper's per-document
-- version: a copy applies only above the stored one.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  customer_id TEXT,
  user_id TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ,
  pg_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_events_event_id
  ON billing_events (event_id);
