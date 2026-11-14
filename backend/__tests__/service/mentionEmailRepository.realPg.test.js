/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F512 on real PostgreSQL. The unit suite runs these statements on pg-mem,
 * which has no row locks, so the one property that matters most, two passes
 * claiming one recipient's 6h window at once, is only evidence here.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const USER = 'aaaaaaaaaaaaaaaaaaaaaa01';
const POD = 'bbbbbbbbbbbbbbbbbbbbbb01';
const HOUR = 3600000;

real('mention email stores on real PostgreSQL (F512)', () => {
  let database;
  let repo;

  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDbPg.pool = database.pool;
    await runPgMigrations(database.pool);
    jest.isolateModules(() => { repo = require('../../repositories/mentionEmailRepository'); });
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  it('lets exactly one of several concurrent passes claim the window', async () => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 6 * HOUR);
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => (
      repo.claimWindow(USER, POD, `item${i}`, now, windowStart))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean).previous).toBeNull();
  });

  it('refuses a claim inside the window and allows one after it', async () => {
    const first = new Date(Date.now() - 7 * HOUR);
    expect(await repo.claimWindow(USER, POD, 'a', first, new Date(first.getTime() - 6 * HOUR))).not.toBeNull();
    const soon = new Date(first.getTime() + HOUR);
    expect(await repo.claimWindow(USER, POD, 'b', soon, new Date(soon.getTime() - 6 * HOUR))).toBeNull();
    const later = new Date();
    const claim = await repo.claimWindow(USER, POD, 'c', later, new Date(later.getTime() - 6 * HOUR));
    expect(claim.previous.getTime()).toBe(first.getTime());
  });

  it('gives a refused send back the earlier window, and only the window it claimed', async () => {
    const earlier = new Date(Date.now() - 7 * HOUR);
    await repo.claimWindow(USER, POD, 'a', earlier, new Date(earlier.getTime() - 6 * HOUR));
    const now = new Date();
    const claim = await repo.claimWindow(USER, POD, 'b', now, new Date(now.getTime() - 6 * HOUR));
    // A release for a time this row no longer holds changes nothing.
    await repo.releaseWindow(USER, POD, new Date(now.getTime() + 1), claim.previous);
    let row = (await database.pool.query('SELECT last_email_at FROM mention_email_state')).rows[0];
    expect(new Date(row.last_email_at).getTime()).toBe(now.getTime());
    await repo.releaseWindow(USER, POD, now, claim.previous);
    row = (await database.pool.query('SELECT last_email_at FROM mention_email_state')).rows[0];
    expect(new Date(row.last_email_at).getTime()).toBe(earlier.getTime());
  });

  it('never rewinds a visit stamp, whatever order the writes land in', async () => {
    const t0 = new Date(Date.now() - HOUR);
    const t1 = new Date(t0.getTime() + 60000);
    await repo.stampOpened(USER, POD, t1);
    await repo.stampOpened(USER, POD, t0);
    await repo.stampRead(USER, POD, t0);
    await repo.stampClosed(USER, POD, t1);
    await repo.stampClosed(USER, POD, t0);
    const visit = await repo.getVisit(USER, POD);
    expect(visit.openedAt.getTime()).toBe(t1.getTime());
    expect(visit.closedAt.getTime()).toBe(t1.getTime());
    expect(visit.readAt.getTime()).toBe(t0.getTime());
    expect(await repo.firstVisitAt()).toBeInstanceOf(Date);
  });
});
