-- F183: one row per run of the nightly PG mirror repair
-- (services/pgMirrorRepairService.ts). Mongo is the source of truth for pods,
-- pod_members and users; the job compares the PG copies against it, repairs
-- them when PG_MIRROR_REPAIR_APPLY=1, and records what it found here, because a
-- pod's logs do not outlive a restart. A row with finished_at NULL is an
-- interrupted run, not a clean one.
--
-- counts         drift per category, as observed before any repair
-- unexplained    orphan pods + non-tombstone orphan users + failed repairs +
--                fields that differed again the night after an applied repair
-- mismatch_keys  'table:id:field' keys seen this run; the next run compares
--                against them to spot a live writer that bypasses the mirror
--
-- Self-contained on purpose: no dependency on another migration's tables, so
-- the file can be renumbered at merge time without edits.
CREATE TABLE IF NOT EXISTS pg_mirror_repair_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP WITH TIME ZONE,
  applied BOOLEAN NOT NULL DEFAULT false,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  unexplained INTEGER NOT NULL DEFAULT 0,
  mismatch_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_pg_mirror_repair_runs_started_at
  ON pg_mirror_repair_runs(started_at DESC);
