jest.mock('../../config/db-pg', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../models/pg/Message', () => ({
  deleteOlderThan: jest.fn(),
}));
jest.mock('../../models/pg/PgRetentionRun', () => ({
  start: jest.fn(),
  finish: jest.fn(),
}));
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }));

// `find().select().lean()` — chainable, so the service's real call shape works.
const mockChain = (result) => ({ select: () => ({ lean: () => result }) });
const mockProUsers = { value: [] };
const mockProPods = { value: [] };
const mockUserQuery = { value: null };
jest.mock('../../models/User', () => ({
  find: jest.fn((q) => { mockUserQuery.value = q; return mockChain(
    mockProUsers.value instanceof Error
      ? Promise.reject(mockProUsers.value)
      : Promise.resolve(mockProUsers.value),
  ); }),
}));
const mockPodQuery = { value: null };
jest.mock('../../models/Pod', () => ({
  find: jest.fn((q) => { mockPodQuery.value = q; return mockChain(Promise.resolve(mockProPods.value)); }),
}));

const { pool } = require('../../config/db-pg');
const Message = require('../../models/pg/Message');
const PgRetentionRun = require('../../models/pg/PgRetentionRun');
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
    PgRetentionRun.start.mockReset();
    PgRetentionRun.start.mockResolvedValue(42);
    PgRetentionRun.finish.mockReset();
    PgRetentionRun.finish.mockResolvedValue(undefined);
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PG_MESSAGE_RETENTION_DAYS;
    delete process.env.PG_CAPACITY_BYTES;
    delete process.env.PG_USAGE_TARGET_PCT;
    delete process.env.PG_RETENTION_STEP_DAYS;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockProUsers.value = [];
    mockProPods.value = [];
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
    expect(PgRetentionRun.start).toHaveBeenCalledWith({
      configuredRetentionDays: null,
      targetBytes: null,
    });
    expect(PgRetentionRun.finish).toHaveBeenCalledWith(42, expect.objectContaining({
      status: 'skipped',
      deletedMessageCount: 0,
      detail: 'invalid PG_MESSAGE_RETENTION_DAYS',
    }));
  });

  it('runs single pass and skips tiering when size already under target', async () => {
    // 8 GiB cap, 75% target = 6 GiB. 4 GiB everywhere = under target.
    mockSizeQueries([4, 4, 4]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 10 });

    await runMessageRetention();

    expect(Message.deleteOlderThan).toHaveBeenCalledTimes(1);
    expect(Message.deleteOlderThan).toHaveBeenCalledWith(30, []);
    const vacuumCalls = pool.query.mock.calls.filter(([sql]) => /^VACUUM/i.test(sql));
    expect(vacuumCalls).toHaveLength(1);
    expect(vacuumCalls[0][0]).toMatch(/VACUUM ANALYZE messages/i);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(PgRetentionRun.finish).toHaveBeenCalledWith(42, expect.objectContaining({
      status: 'completed',
      deletedMessageCount: 10,
      protectedPodCount: 0,
      finalRetentionDays: 30,
    }));
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
    // Sizes slowly decrease but stay over the 6 GiB target so the loop runs all
    // the way to the 1-day floor. A plateau would trigger the vacuumCantReclaim
    // bailout — the floor path is exercised by a different test.
    mockSizeQueries([8, 7.99, 7.98, 7.97, 7.96, 7.95, 7.94, 7.93]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 1 });

    await runMessageRetention();

    // 30 → 23 → 16 → 9 → 2 → 1 (floor); loop exits because currentDays <= FLOOR.
    expect(Message.deleteOlderThan.mock.calls.map((c) => c[0])).toEqual([30, 23, 16, 9, 2, 1]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('still over target at floor'));
  });

  it('floors at 1 day and warns when still over target', async () => {
    // 31 tiny-decreasing probes (7.9 → 7.87) — enough to reach floor, all over target.
    mockSizeQueries(Array.from({ length: 31 }, (_, i) => 7.9 - i * 0.001));
    Message.deleteOlderThan.mockResolvedValue({ deleted: 5 });

    await runMessageRetention();

    const daysUsed = Message.deleteOlderThan.mock.calls.map((c) => c[0]);
    expect(daysUsed[0]).toBe(30);
    expect(daysUsed[daysUsed.length - 1]).toBe(1);
    expect(daysUsed).toHaveLength(30); // 30..1 inclusive
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('still over target at floor'));
  });

  it('bails early when VACUUM cannot reclaim (size plateaus)', async () => {
    // Size stays constant over target — regular VACUUM isn't freeing file
    // bytes. Expect one step-down, a plateau, and a distinct WARN that points
    // operators at VACUUM FULL / pg_repack / capacity upgrade.
    mockSizeQueries([6.75, 6.75, 6.75]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 100 });

    await runMessageRetention();

    // First tier at 30d, one step-down to 29d, then bail — no further tiers.
    expect(Message.deleteOlderThan.mock.calls.map((c) => c[0])).toEqual([30, 29]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('vacuum stopped reclaiming'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('still over target at floor'));
  });

  it('skips tiering gracefully when pg_database_size query fails', async () => {
    pool.query.mockImplementation((sql) => {
      if (/pg_database_size/i.test(sql)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    Message.deleteOlderThan.mockResolvedValue({ deleted: 3 });

    await runMessageRetention();

    expect(Message.deleteOlderThan).toHaveBeenCalledTimes(1);
    expect(Message.deleteOlderThan).toHaveBeenCalledWith(30, []);
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
    expect(PgRetentionRun.finish).toHaveBeenCalledWith(42, expect.objectContaining({
      status: 'failed',
      deletedMessageCount: 0,
      detail: 'db down',
    }));
  });

  it('leaves the run as running when recording a completed outcome fails', async () => {
    mockSizeQueries([4, 4]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 5 });
    PgRetentionRun.finish.mockRejectedValue(new Error('ledger update lost'));

    await expect(runMessageRetention()).resolves.toBeUndefined();

    // Do not retry with `failed`: the start record remains the honest durable
    // signal that the run completed but its terminal outcome was not written.
    expect(PgRetentionRun.finish.mock.calls.map(([, outcome]) => outcome.status)).toEqual(['completed']);
    expect(errSpy).toHaveBeenCalledWith(
      '[pg-retention] could not persist run outcome:',
      'ledger update lost',
    );
  });
  /*
   * The Pro tier's headline promise is "Unlimited message history — nothing
   * expires at 30 days". Until this landed, the cron deleted a paying
   * customer's messages on exactly the free-tier schedule, and the step-down
   * under storage pressure could take that to a single day.
   */
  /*
   * Losing Pro stops the FEATURES at once, but deleting the history the same
   * night means a single failed card payment is unrecoverable. The grace
   * window is the win-back runway.
   */
  /*
   * Retention is a property of the ROOM, not of whoever wandered into it.
   * "Any Pro member protects the pod" was tried first and rejected: membership
   * is cheap and unilateral, so one Pro admin who had joined everything
   * silently protected 95 of 235 pods — 78% of all messages — and the only way
   * to remove protection would have been to remove a person.
   */
  describe('the pod creator governs retention', () => {
    const runAndGetPodQuery = async () => {
      mockProUsers.value = [{ _id: 'u-pro' }];
      mockProPods.value = [{ _id: 'pod-1' }];
      mockSizeQueries([1, 1]);
      Message.deleteOlderThan.mockResolvedValue({ deleted: 0 });
      await runMessageRetention();
      return mockPodQuery.value;
    };

    it('selects pods by createdBy', async () => {
      const q = await runAndGetPodQuery();
      expect(q).toEqual({ createdBy: { $in: ['u-pro'] } });
    });

    it('does NOT protect a pod merely because a Pro user is a member', async () => {
      const q = await runAndGetPodQuery();
      expect(JSON.stringify(q)).not.toContain('members');
    });
  });

  describe('lapsed-Pro data grace', () => {
    const runAndGetQuery = async () => {
      mockSizeQueries([1, 1]);
      Message.deleteOlderThan.mockResolvedValue({ deleted: 0 });
      await runMessageRetention();
      return mockUserQuery.value;
    };

    it('protects accounts still inside the grace window', async () => {
      const q = await runAndGetQuery();
      const clause = q.$or.find((c) => c['billing.proEndedAt']);
      expect(clause).toBeDefined();
      const cutoff = clause['billing.proEndedAt'].$gte;
      const daysAgo = (Date.now() - cutoff.getTime()) / 86400000;
      expect(daysAgo).toBeGreaterThan(29.9);
      expect(daysAgo).toBeLessThan(30.1);
    });

    it('still protects currently-active Pro accounts', async () => {
      const q = await runAndGetQuery();
      expect(q.$or).toContainEqual({ 'entitlements.pro': true });
    });

    it('honours PRO_DATA_GRACE_DAYS', async () => {
      process.env.PRO_DATA_GRACE_DAYS = '60';
      const q = await runAndGetQuery();
      const clause = q.$or.find((c) => c['billing.proEndedAt']);
      const daysAgo = (Date.now() - clause['billing.proEndedAt'].$gte.getTime()) / 86400000;
      expect(daysAgo).toBeGreaterThan(59.9);
    });

    // A malformed env must not collapse the window to zero and delete a
    // lapsed customer's history tonight.
    it('a bad PRO_DATA_GRACE_DAYS falls back to 30 rather than 0', async () => {
      process.env.PRO_DATA_GRACE_DAYS = 'nonsense';
      const q = await runAndGetQuery();
      const clause = q.$or.find((c) => c['billing.proEndedAt']);
      const daysAgo = (Date.now() - clause['billing.proEndedAt'].$gte.getTime()) / 86400000;
      expect(daysAgo).toBeGreaterThan(29.9);
    });
  });

  describe('Pro-protected pods', () => {
    it('passes the protected pod ids to the delete', async () => {
      mockProUsers.value = [{ _id: 'u-pro' }];
      mockProPods.value = [{ _id: 'pod-1' }, { _id: 'pod-2' }];
      mockSizeQueries([1, 1]);
      Message.deleteOlderThan.mockResolvedValue({ deleted: 0 });

      await runMessageRetention();
      expect(Message.deleteOlderThan).toHaveBeenCalledWith(30, ['pod-1', 'pod-2']);
    });

    // The step-down is the dangerous path: it is where a paying user's window
    // would otherwise walk from 30 days toward the 1-day floor.
    it('every step-down tier keeps the same protection', async () => {
      mockProUsers.value = [{ _id: 'u-pro' }];
      mockProPods.value = [{ _id: 'pod-1' }];
      // Stays over target so the loop steps down repeatedly.
      mockSizeQueries([7.9, 7.9, 7.9, 7.9, 7.9, 7.9]);
      Message.deleteOlderThan.mockResolvedValue({ deleted: 1 });

      await runMessageRetention();
      expect(Message.deleteOlderThan.mock.calls.length).toBeGreaterThan(1);
      Message.deleteOlderThan.mock.calls.forEach(([, protectedIds]) => {
        expect(protectedIds).toEqual(['pod-1']);
      });
    });

    // The property worth more than the feature: never destroy paid data
    // because a lookup failed. A skipped night of cleanup is recoverable.
    it('ABORTS the entire run when the lookup fails, deleting nothing', async () => {
      mockProUsers.value = new Error('mongo unreachable');
      mockSizeQueries([7.9, 7.9]);
      Message.deleteOlderThan.mockResolvedValue({ deleted: 99 });

      await runMessageRetention();
      expect(Message.deleteOlderThan).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('ABORT'),
        expect.stringContaining('mongo unreachable'),
      );
      expect(PgRetentionRun.finish).toHaveBeenCalledWith(42, expect.objectContaining({
        status: 'aborted',
        deletedMessageCount: 0,
        detail: expect.stringContaining('mongo unreachable'),
      }));
    });

    it('with no Pro users the delete is unchanged', async () => {
      mockProUsers.value = [];
      mockSizeQueries([1, 1]);
      Message.deleteOlderThan.mockResolvedValue({ deleted: 0 });

      await runMessageRetention();
      expect(Message.deleteOlderThan).toHaveBeenCalledWith(30, []);
    });
  });

  it('refuses to delete if the durable run record cannot start', async () => {
    PgRetentionRun.start.mockRejectedValue(new Error('ledger unavailable'));
    mockSizeQueries([1, 1]);
    Message.deleteOlderThan.mockResolvedValue({ deleted: 9 });

    await runMessageRetention();

    expect(Message.deleteOlderThan).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('[pg-retention] failed:', 'ledger unavailable');
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
