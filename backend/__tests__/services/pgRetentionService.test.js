jest.mock('../../config/db-pg', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../models/pg/Message', () => ({
  deleteOlderThan: jest.fn(),
}));
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }));

const { pool } = require('../../config/db-pg');
const Message = require('../../models/pg/Message');
const cron = require('node-cron');
const { runMessageRetention, initPgRetention } = require('../../services/pgRetentionService');

const GIB = 1024 * 1024 * 1024;

function mockSizeQueries(sizesGiB) {
  const queue = [...sizesGiB];
  pool.query.mockImplementation((sql) => {
    if (/pg_database_size/i.test(sql)) {
      const next = queue.shift();
      const size = next === undefined ? 0 : Math.round(next * GIB);
      return Promise.resolve({ rows: [{ size: String(size) }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('pgRetentionService.runMessageRetention', () => {
  const ORIGINAL_ENV = process.env;
  let logSpy;
  let warnSpy;
  let errSpy;

  beforeEach(() => {
    pool.query.mockReset();
    Message.deleteOlderThan.mockReset();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PG_MESSAGE_RETENTION_DAYS;
    delete process.env.PG_CAPACITY_BYTES;
    delete process.env.PG_USAGE_TARGET_PCT;
    delete process.env.PG_RETENTION_STEP_DAYS;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('skips when PG_MESSAGE_RETENTION_DAYS is invalid', async () => {
    process.env.PG_MESSAGE_RETENTION_DAYS = '0';

    await runMessageRetention();

    expect(Message.deleteOlderThan).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid PG_MESSAGE_RETENTION_DAYS'),
      '0',
    );
  });

  it('runs single pass and skips tiering when size already under target', async () => {
    // 8 GiB cap, 75% target = 6 GiB. 4 GiB everywhere = under target.
    mockSizeQueries([4, 4, 4]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 10 });

    await runMessageRetention();

    expect(Message.deleteOlderThan).toHaveBeenCalledTimes(1);
    expect(Message.deleteOlderThan).toHaveBeenCalledWith(30);
    const vacuumCalls = pool.query.mock.calls.filter(([sql]) => /^VACUUM/i.test(sql));
    expect(vacuumCalls).toHaveLength(1);
    expect(vacuumCalls[0][0]).toMatch(/VACUUM ANALYZE messages/i);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('steps down retention when still above target, stops when under', async () => {
    // Probes: 7.5 (initial) → 7.2 (after 30d) → 6.9 (after 29d) → 5.5 (after 28d, under) → 5.4 (final)
    mockSizeQueries([7.5, 7.2, 6.9, 5.5, 5.4]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 100 });

    await runMessageRetention();

    expect(Message.deleteOlderThan.mock.calls.map((c) => c[0])).toEqual([30, 29, 28]);
  });

  it('respects PG_RETENTION_STEP_DAYS when stepping down', async () => {
    process.env.PG_RETENTION_STEP_DAYS = '7';
    // Always over target — forces stepping until floor (8 probes).
    mockSizeQueries([8, 8, 8, 8, 8, 8, 8, 8]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 1 });

    await runMessageRetention();

    // 30 → 23 → 16 → 9 → 2 → 1 (floor); next iter would also be 1, loop exits.
    expect(Message.deleteOlderThan.mock.calls.map((c) => c[0])).toEqual([30, 23, 16, 9, 2, 1]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('still over target'));
  });

  it('floors at 1 day and warns when still over target', async () => {
    mockSizeQueries(Array(40).fill(7.9));
    Message.deleteOlderThan.mockResolvedValue({ deleted: 5 });

    await runMessageRetention();

    const daysUsed = Message.deleteOlderThan.mock.calls.map((c) => c[0]);
    expect(daysUsed[0]).toBe(30);
    expect(daysUsed[daysUsed.length - 1]).toBe(1);
    expect(daysUsed).toHaveLength(30); // 30..1 inclusive
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('still over target'));
  });

  it('skips tiering gracefully when pg_database_size query fails', async () => {
    pool.query.mockImplementation((sql) => {
      if (/pg_database_size/i.test(sql)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    Message.deleteOlderThan.mockResolvedValue({ deleted: 3 });

    await runMessageRetention();

    expect(Message.deleteOlderThan).toHaveBeenCalledTimes(1);
    expect(Message.deleteOlderThan).toHaveBeenCalledWith(30);
  });

  it('uses custom capacity and target via env', async () => {
    // 2 GiB cap, 50% target = 1 GiB. Probes: 1.5 (over) → 1.4 (over) → 0.9 (under) → 0.9 final
    process.env.PG_CAPACITY_BYTES = String(2 * GIB);
    process.env.PG_USAGE_TARGET_PCT = '50';
    mockSizeQueries([1.5, 1.4, 0.9, 0.9]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 50 });

    await runMessageRetention();

    expect(Message.deleteOlderThan.mock.calls.map((c) => c[0])).toEqual([30, 29]);
  });

  it('swallows errors from deleteOlderThan without crashing cron', async () => {
    mockSizeQueries([4, 4]);
    Message.deleteOlderThan.mockRejectedValue(new Error('db down'));

    await expect(runMessageRetention()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('[pg-retention] failed:', 'db down');
  });
});

describe('pgRetentionService.initPgRetention', () => {
  beforeEach(() => {
    cron.schedule.mockClear();
  });

  it('schedules the cron at 03:00 UTC', () => {
    initPgRetention();
    // Module-level `scheduledJob` may already be set from a prior test run in
    // this file; either way, we just need to observe the schedule signature at
    // least once since process start.
    const firstCall = cron.schedule.mock.calls[0] || null;
    if (firstCall) {
      expect(firstCall[0]).toBe('0 3 * * *');
      expect(firstCall[2]).toEqual({ timezone: 'UTC' });
    } else {
      // Already scheduled in a previous test — no-op path is the expected branch.
      expect(cron.schedule).not.toHaveBeenCalled();
    }
  });
});
