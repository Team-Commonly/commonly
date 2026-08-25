/**
 * Retention-run ledger — executed against real PostgreSQL.
 *
 * The claim is persistence across a backend restart, which pg-mem cannot
 * establish. A separate Pool is the relevant control: the model writes with
 * the application's pool; this reader observes the committed outcome through
 * a fresh connection.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const PgRetentionRun = require('../../models/pg/PgRetentionRun');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;
const TEST_DETAIL = 'pg-retention-run-tier1-test';

let pool;

const connect = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

d('pg_retention_runs, against a real database', () => {
  beforeAll(async () => {
    pool = connect();
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM pg_retention_runs WHERE detail = $1', [TEST_DETAIL]);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM pg_retention_runs WHERE detail = $1', [TEST_DETAIL]);
      await pool.end();
    }
    // The model owns a second pool; close it so Jest does not retain a handle.
    // eslint-disable-next-line global-require
    const { pool: modelPool } = require('../../config/db-pg');
    if (modelPool?.end) await modelPool.end();
  });

  test('a completed deletion count survives a new database connection', async () => {
    const runId = await PgRetentionRun.start({ configuredRetentionDays: 30, targetBytes: 6 });
    await PgRetentionRun.finish(runId, {
      status: 'completed',
      finalRetentionDays: 30,
      protectedPodCount: 71,
      deletedMessageCount: 9,
      initialSizeBytes: 1024,
      finalSizeBytes: 1000,
      detail: TEST_DETAIL,
    });

    const observer = connect();
    try {
      const { rows } = await observer.query(
        `SELECT status, deleted_message_count, protected_pod_count, finished_at
           FROM pg_retention_runs WHERE id = $1`,
        [runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('completed');
      expect(Number(rows[0].deleted_message_count)).toBe(9);
      expect(Number(rows[0].protected_pod_count)).toBe(71);
      expect(rows[0].finished_at).toBeTruthy();
    } finally {
      await observer.end();
    }
  });
});
