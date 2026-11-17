-- A person's read point in a pod's main channel, so opening the pod can show
-- what arrived since their last visit. Written only by PUT
-- /api/pods/:id/read-point, which moves it forward and never back. No row
-- means "no visit recorded yet", which shows no divider. Thread replies keep
-- their own read points in thread_user_state.last_read_at (0011).
CREATE TABLE IF NOT EXISTS pod_read_points (
  pod_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pod_id, user_id)
);
