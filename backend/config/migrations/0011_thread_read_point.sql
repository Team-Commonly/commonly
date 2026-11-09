-- D278: a person's read point in a thread, so the main channel's thread chip
-- can show what they haven't read. Only PUT /api/messages/:id/read writes it,
-- and it only moves forward. NULL means "never opened", which renders no
-- unread mark: old threads don't light up for people who were never in them.
ALTER TABLE thread_user_state ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
