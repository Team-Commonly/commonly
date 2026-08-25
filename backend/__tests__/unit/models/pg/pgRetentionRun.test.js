jest.mock('../../../../config/db-pg', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../../../../config/db-pg');
const PgRetentionRun = require('../../../../models/pg/PgRetentionRun');

describe('PgRetentionRun', () => {
  beforeEach(() => pool.query.mockReset());

  it('starts a durable row before retention work begins', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: '7' }], rowCount: 1 });

    await expect(PgRetentionRun.start({ configuredRetentionDays: 30, targetBytes: 6 })).resolves.toBe(7);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO pg_retention_runs/);
    expect(params).toEqual([30, 6]);
  });

  it('persists the outcome fields that a restart would otherwise discard', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await PgRetentionRun.finish(7, {
      status: 'completed',
      finalRetentionDays: 30,
      protectedPodCount: 71,
      deletedMessageCount: 9,
      initialSizeBytes: 1024,
      finalSizeBytes: 1000,
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE pg_retention_runs/);
    expect(sql).toMatch(/finished_at = CURRENT_TIMESTAMP/);
    expect(params).toEqual([7, 'completed', 30, 71, 9, 1024, 1000, null]);
  });

  it('refuses to report an outcome for a run that was not recorded', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(PgRetentionRun.finish(7, {
      status: 'failed',
      finalRetentionDays: null,
      protectedPodCount: null,
      deletedMessageCount: 0,
      initialSizeBytes: null,
      finalSizeBytes: null,
      detail: 'database down',
    })).rejects.toThrow('run ledger row 7 was not found');
  });
});
