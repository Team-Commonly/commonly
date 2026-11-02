-- ADR-034 Wave 0: tables that used to create themselves on first use.
-- `services/messageClaimService.ts` and `models/ToolCall.ts` each ran this DDL
-- at runtime; it lives here now, and the services just use the pool.
--
-- Production already holds both tables with every retrofitted column, so every
-- statement is idempotent: IF NOT EXISTS throughout, and types, defaults and
-- NOT NULL copied exactly from the runtime DDL it replaces. A fresh install
-- ends with the identical shape.

-- ADR-018 attention claims: one lease row per message, keyed by message id.
CREATE TABLE IF NOT EXISTS message_claims (
  message_id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT 'default',
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'claimed',
  declined_by TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The table predates this migration, so this retrofit is still required for
-- instances that created it before decline handoff existed. CREATE TABLE IF
-- NOT EXISTS alone never adds columns.
ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'claimed';
ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS declined_by TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
-- TASK-099: the named half of a released refusal. Nullable by design —
-- every pre-existing row, and every non-refused outcome, has no reason.
ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS refusal_reason TEXT;
ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS refusal_status INTEGER;
-- Expired rows are dead weight; the CAS treats them as absent. A small
-- index makes the pod-scoped sweep cheap if one is ever added.
CREATE INDEX IF NOT EXISTS idx_message_claims_pod ON message_claims (pod_id);
CREATE INDEX IF NOT EXISTS idx_message_claims_terminal_expiry ON message_claims (state, expires_at);

-- Room-grant broker trail. 0001 already creates `tool_call_budgets`,
-- `tool_calls` (with every column) and `idx_tool_calls_grant_at`, so only the
-- retrofits are new here. An instance whose `tool_calls` was created at runtime
-- before the trail carried a credential owner or vendor diagnostics skipped
-- 0001's CREATE TABLE IF NOT EXISTS, and these ALTERs are what add the columns.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS credential_owner_id VARCHAR(255);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS vendor_status INTEGER;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS vendor_error VARCHAR(200);
