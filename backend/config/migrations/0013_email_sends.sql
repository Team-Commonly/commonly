-- F519: does an email bring the person back? One row per email the provider
-- accepted, for the kinds whose links carry a return tag: the daily digest
-- (its stalled-connect lines ride it), a needs-you ask, a teammate's @mention.
--
-- send_id is the random id in the link's ?em=<kind>.<send_id>; it names no one.
-- returned_at is the first signed-in visit that arrived with it, recorded only
-- for the recipient. pod_id is the pod the email pointed at (NULL for the
-- digest, which points at Activity), so "posted in that pod within 24h" is a
-- read over messages at count time, not a stored flag.
--
-- Self-contained on purpose: no dependency on another migration's tables, so
-- the file can be renumbered at merge time without edits.
CREATE TABLE IF NOT EXISTS email_sends (
  send_id VARCHAR(24) PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  recipient_user_id VARCHAR(24) NOT NULL,
  pod_id VARCHAR(24),
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
  returned_at TIMESTAMP WITH TIME ZONE
);
-- The count reads a sent_at range across every kind.
CREATE INDEX IF NOT EXISTS idx_email_sends_sent_at ON email_sends(sent_at);
