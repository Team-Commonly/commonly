/**
 * Message.findActivityHint — metadata only, one query.
 *
 * Why this exists: for five months this ran a SECOND query per pod per
 * heartbeat tick — the three most recent messages, joined to `users` for a
 * username — whose result nothing in the repo read. 089d0058 shipped those
 * rows into `activityHint.recentMessages` for the model; 8608060d removed the
 * field 23 minutes later from the CONSUMER only, and the producer kept going.
 *
 * The dead join was found by @sprint-review (57711) auditing this query for a
 * missing column. Nothing failed while it was there, which is exactly why it
 * survived — a query with no reader cannot break. These tests give it one.
 */

jest.mock('../../../../config/db-pg', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../../../../config/db-pg');
const Message = require('../../../../models/pg/Message');

const POD = '6a507c9b792f1ed2cbfec648';
const SINCE = new Date('2026-08-25T06:00:00.000Z');

describe('Message.findActivityHint', () => {
  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [{ count: '7', last_at: SINCE }], rowCount: 1 });
  });

  it('issues exactly one query', async () => {
    await Message.findActivityHint(POD, SINCE);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('that query is the aggregate, with no join to users', async () => {
    await Message.findActivityHint(POD, SINCE);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\*\)/);
    expect(sql).toMatch(/MAX\(created_at\)/);
    expect(params).toEqual([POD, SINCE]);
    // Across EVERY call, not just calls[0]. The dead query ran in a
    // Promise.all beside the aggregate, so the aggregate was still first —
    // asserting on calls[0] alone stayed green against the exact code this
    // test exists to reject, and was the one assertion of five that the
    // negative control did not redden.
    const everySql = pool.query.mock.calls.map(([q]) => q).join('\n');
    expect(everySql).not.toMatch(/JOIN users/);
    expect(everySql).not.toMatch(/LIMIT 3/);
  });

  it('returns count and lastAt, and nothing per-message', async () => {
    const hint = await Message.findActivityHint(POD, SINCE);
    expect(hint).toEqual({ count: 7, lastAt: SINCE });
  });

  it('a missing podId short-circuits without touching the pool', async () => {
    const hint = await Message.findActivityHint(undefined, SINCE);
    expect(hint).toEqual({ count: 0, lastAt: null });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a query failure degrades to a zero hint rather than throwing', async () => {
    // The heartbeat's pod-selection pass must not die because the hint did.
    pool.query.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(Message.findActivityHint(POD, SINCE))
      .resolves.toEqual({ count: 0, lastAt: null, unavailable: true });
  });

  // TASK-099. Degrading is right; degrading INDISTINGUISHABLY is the defect.
  // `count: 0` is exactly what a genuinely quiet pod returns, so without a
  // discriminator the caller — and, through the heartbeat prompt, every agent —
  // reads a Postgres outage as "nothing happened here".
  it('a real zero and a failed zero are distinguishable', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: '0', last_at: null }] });
    const quiet = await Message.findActivityHint(POD, SINCE);

    pool.query.mockRejectedValueOnce(new Error('connection terminated'));
    const broken = await Message.findActivityHint(POD, SINCE);

    expect(quiet.count).toBe(0);
    expect(broken.count).toBe(0);
    expect(quiet.unavailable).toBeUndefined();
    expect(broken.unavailable).toBe(true);
    expect(quiet).not.toEqual(broken);
  });
});
