-- F655: accountability in the record. An agent's message names whose agent
-- it is (owner_user_id: its installer in the pod, else its identity's owner,
-- people only) and, when a person's message woke the run, that person
-- (on_behalf_of_user_id). The server derives both: on_behalf_of only from the
-- wake message a native run claimed, never from a reply edge. External
-- runtimes record no on_behalf_of yet (owner only). Both are person ids, so no
-- read hands them out (models/pg/Message strips them). Nullable, NULL on every
-- older row and on a person's own message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(24);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS on_behalf_of_user_id VARCHAR(24);
