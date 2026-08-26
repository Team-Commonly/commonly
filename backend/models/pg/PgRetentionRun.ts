/**
 * PgRetentionRun — durable outcome ledger for the daily PostgreSQL retention job.
 *
 * This is intentionally separate from `migration_records`: a migration is a
 * one-off schema/data transition, while retention is a recurring destructive
 * operation. A missing retention row must mean "no durable observation", not
 * "nothing was due", so every run starts a row before it can delete a message
 * and resolves that row to its actual outcome.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const { pool } = require('../../config/db-pg');

type RetentionRunStatus = 'completed' | 'aborted' | 'failed' | 'skipped';

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ id: number | string }>; rowCount?: number }>;
}

export interface RetentionRunStart {
  configuredRetentionDays: number | null;
  targetBytes: number | null;
}

export interface RetentionRunOutcome {
  status: RetentionRunStatus;
  finalRetentionDays: number | null;
  protectedPodCount: number | null;
  deletedMessageCount: number;
  // Null means the repair itself failed, so zero would be a false claim.
  reRootedCount: number | null;
  initialSizeBytes: number | null;
  finalSizeBytes: number | null;
  detail?: string | null;
}

class PgRetentionRun {
  /**
   * Start before resolving entitlement or deleting. If this cannot be written,
   * the caller must not run deletion invisibly.
   */
  static async start({ configuredRetentionDays, targetBytes }: RetentionRunStart): Promise<number> {
    const { rows } = await (pool as PgPool).query(
      `INSERT INTO pg_retention_runs (configured_retention_days, target_bytes)
       VALUES ($1, $2)
       RETURNING id`,
      [configuredRetentionDays, targetBytes],
    );
    const id = Number(rows[0]?.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('pg-retention run ledger did not return an id');
    }
    return id;
  }

  /** Resolve the run in one update; a row left `running` means interruption. */
  static async finish(runId: number, outcome: RetentionRunOutcome): Promise<void> {
    const result = await (pool as PgPool).query(
      `UPDATE pg_retention_runs
          SET status = $2,
              finished_at = CURRENT_TIMESTAMP,
              final_retention_days = $3,
              protected_pod_count = $4,
              deleted_message_count = $5,
              re_rooted_count = $6,
              initial_size_bytes = $7,
              final_size_bytes = $8,
              detail = $9
        WHERE id = $1`,
      [
        runId,
        outcome.status,
        outcome.finalRetentionDays,
        outcome.protectedPodCount,
        outcome.deletedMessageCount,
        outcome.reRootedCount,
        outcome.initialSizeBytes,
        outcome.finalSizeBytes,
        outcome.detail || null,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(`pg-retention run ledger row ${runId} was not found`);
    }
  }
}

export default PgRetentionRun;
module.exports = exports.default; Object.assign(module.exports, exports);
