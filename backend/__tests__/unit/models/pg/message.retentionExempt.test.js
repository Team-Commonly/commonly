/**
 * Message.deleteOlderThan — retention exemption (PG_RETENTION_EXEMPT_POD_IDS).
 *
 * Why this exists: the delete used to be unconditional, and on 2026-08-05 it
 * was discovered to have silently emptied the public showcase pod the landing
 * page points at — "Watch a live room" led to "No messages yet" for however
 * long nobody checked. The exemption is the guard; these tests are the reason
 * a future simplification of the query has to argue with the incident.
 *
 * Tested at the SQL boundary (mocked pool) because the retention SERVICE test
 * mocks deleteOlderThan away entirely — without this file, the exemption has
 * no test anywhere.
 */

jest.mock('../../../../config/db-pg', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../../../../config/db-pg');
const Message = require('../../../../models/pg/Message');

const SHOWCASE = '6a507c9b792f1ed2cbfec648';
const HQ = '6a5fe677306155f677c26abf';

describe('Message.deleteOlderThan retention exemption', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rowCount: 3, rows: [] });
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PG_RETENTION_EXEMPT_POD_IDS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('unset env keeps the original unconditional delete', async () => {
    const res = await Message.deleteOlderThan(30);
    expect(res).toEqual({ deleted: 3 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/pod_id/);
    expect(params).toEqual(['30 days']);
  });

  it('exempt pods are excluded from the delete', async () => {
    process.env.PG_RETENTION_EXEMPT_POD_IDS = `${SHOWCASE},${HQ}`;
    await Message.deleteOlderThan(30);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/pod_id != ALL\(\$2\)/);
    expect(params).toEqual(['30 days', [SHOWCASE, HQ]]);
  });

  it('whitespace and empty entries in the list are tolerated', async () => {
    process.env.PG_RETENTION_EXEMPT_POD_IDS = ` ${SHOWCASE} , , ${HQ} ,`;
    await Message.deleteOlderThan(30);
    const [, params] = pool.query.mock.calls[0];
    expect(params[1]).toEqual([SHOWCASE, HQ]);
  });

  it('an env of only separators falls back to the unconditional delete', async () => {
    // An empty ALL(ARRAY[]) is harmless in Postgres, but the unconditional
    // path is what ran for months — keep it byte-identical when the list is
    // effectively empty, so this change is provably a no-op for every
    // deployment that does not set the var.
    process.env.PG_RETENTION_EXEMPT_POD_IDS = ' , ,, ';
    await Message.deleteOlderThan(30);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/pod_id/);
    expect(params).toEqual(['30 days']);
  });

  it('invalid day counts still refuse to run at all', async () => {
    process.env.PG_RETENTION_EXEMPT_POD_IDS = SHOWCASE;
    expect(await Message.deleteOlderThan(0)).toEqual({ deleted: 0 });
    expect(await Message.deleteOlderThan(NaN)).toEqual({ deleted: 0 });
    expect(pool.query).not.toHaveBeenCalled();
  });
});
