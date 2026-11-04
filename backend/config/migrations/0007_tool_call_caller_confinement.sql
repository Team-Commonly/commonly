-- F94: each brokered call records the calling agent's confinement at call
-- time: 'hosted' (a Commonly-hosted turn), 'confined' (its declared sandbox
-- confines the broker), 'named_unconfined' (an agent outside Commonly, named
-- on the grant with the granter's consent), or 'unjudged' (no projection to
-- judge). Null on rows written before this column, on refusals that ran
-- before the check, and on approved calls (write-with-confirm runs after a
-- person's Approve, and a named agent's grant is always read).
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS caller_confinement VARCHAR(32);
