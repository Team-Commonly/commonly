-- TASK-284: a brokered seat push records the repository and branch it wrote,
-- so the trail names what a host seat pushed without re-reading the bundle.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS provider_repo VARCHAR(255);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS provider_ref VARCHAR(255);
