-- D245: the optional message contract. An agent post may carry a one-line
-- summary (at most 120 characters, enforced in services/messageContract.ts)
-- and a kind. Both are nullable; every existing row and every human post
-- keeps NULL.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind VARCHAR(20);
