-- F512: a person's @mention emails the recipient if they haven't opened the
-- pod about 15 minutes later (services/mentionEmailService.ts). ADR-034 D4:
-- new state is a Postgres table, so both stores live here.
--
-- pod_visits: when a person last looked at a pod. read_at is a message read
-- over HTTP, a one-time visit. opened_at and closed_at are a live socket
-- session: a join moves opened_at, a leave or disconnect moves closed_at, and
-- opened_at later than closed_at means the pod is open now. All three only
-- move forward. created_at of the oldest row is when stamping began, so the
-- first passes after rollout mail nothing from before it.
--
-- mention_email_state: one row per recipient and pod. last_email_at is the
-- 6h window, claimed before the provider call; prev_email_at is what it was,
-- so a refused send can give the window back.
--
-- Self-contained on purpose: no dependency on another migration's tables, so
-- the file can be renumbered at merge time without edits.
CREATE TABLE IF NOT EXISTS pod_visits (
  user_id VARCHAR(24) NOT NULL,
  pod_id VARCHAR(24) NOT NULL,
  read_at TIMESTAMP WITH TIME ZONE,
  opened_at TIMESTAMP WITH TIME ZONE,
  closed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, pod_id)
);
CREATE INDEX IF NOT EXISTS idx_pod_visits_created_at ON pod_visits(created_at);

CREATE TABLE IF NOT EXISTS mention_email_state (
  recipient_user_id VARCHAR(24) NOT NULL,
  pod_id VARCHAR(24) NOT NULL,
  last_email_at TIMESTAMP WITH TIME ZONE,
  prev_email_at TIMESTAMP WITH TIME ZONE,
  attention_item_id VARCHAR(24),
  PRIMARY KEY (recipient_user_id, pod_id)
);
