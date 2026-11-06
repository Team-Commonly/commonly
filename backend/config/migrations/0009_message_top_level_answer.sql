-- F212: an agent's answer to a main-channel mention can quote that message
-- and still sit in the channel, so a row with a reply edge and no root is no
-- longer always a chain the retention repair has to re-root. This marks the
-- ones that are top-level on purpose. Nullable, and NULL on every other row.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS top_level_answer BOOLEAN;
