-- F525: connect codes. The connect page's one pasted line carries a short-lived
-- code, not the agent's lasting runtime key; the CLI trades it for the key on
-- POST /api/agents/runtime/connect-code (docs/agents/connect-code.md).
-- ADR-034 D4: new state is a Postgres table.
--
-- One row per live code, one live code per agent. code_hash is the code's
-- sha256; the code itself is never stored. sealed/iv/tag are the key sealed
-- with AES-256-GCM under a key derived from the code, bound to agent_user_id
-- and token_hash, so this table alone can't recover the key. redeems counts
-- successful claims against the per-code cap. Expired rows are deleted on
-- each mint and refused by the redeem query itself.
--
-- Self-contained on purpose: no dependency on another migration's tables, so
-- the file can be renumbered at merge time without edits.
CREATE TABLE IF NOT EXISTS agent_connect_codes (
  code_hash VARCHAR(64) PRIMARY KEY,
  agent_user_id VARCHAR(24) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  sealed TEXT NOT NULL,
  iv VARCHAR(32) NOT NULL,
  tag VARCHAR(32) NOT NULL,
  redeems INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Unique per agent, so two mints at once still leave one live code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_connect_codes_agent ON agent_connect_codes(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_connect_codes_expires ON agent_connect_codes(expires_at);
