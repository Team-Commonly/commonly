-- TASK-513: server-written record-v1 chains (packages/seats/docs/record-v1.md,
-- ADR-033). The backend is the only writer, so one chain per (pod, task) and
-- one taskless chain per pod (task_id = '') stand in for the spec's one run
-- per file. Each line is stored as the exact canonical bytes the shared
-- writer produced, so a reader returns them unchanged and the chain verifies.
CREATE TABLE IF NOT EXISTS record_chains (
  id BIGSERIAL PRIMARY KEY,
  pod_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(64) NOT NULL DEFAULT '',
  run_id VARCHAR(64) NOT NULL UNIQUE,
  -- The spec's outside record of the head (section 4): SHA-256 of the last
  -- line and the line count. A writer updates both in the transaction that
  -- appends the line, under this row's lock.
  head_seq INTEGER NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  head_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pod_id, task_id)
);

CREATE TABLE IF NOT EXISTS record_lines (
  chain_id BIGINT NOT NULL REFERENCES record_chains(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  line TEXT NOT NULL,
  -- One source event (a committed board, grant or broker write) can emit
  -- several lines; each carries `<event key>/<index>`, so a redelivered
  -- event is recognised and written once.
  source_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, seq),
  UNIQUE (chain_id, source_key)
);
