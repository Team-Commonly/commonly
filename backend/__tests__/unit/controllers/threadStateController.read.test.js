// PUT /api/messages/:messageId/read (D278): a person's read point in a thread.
// Same harness as threadStateController.podAccess.test.js — pg-mem holds the
// message and thread-state rows (built from the shipped DDL, so the 0011
// column is the one that ships), memory Mongo holds the pods, and
// podWriteAccessService runs unmocked, so the refusals are real ones.
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { applyTable } = require('../../utils/schemaTable');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { setThreadRead, listThreadState } = require('../../../controllers/threadStateController');

const ROOT_ID = 1;
const REPLY_ID = 2;
const OTHER_ROOT_ID = 3;
const OTHER_REPLY_ID = 4;

const call = async (handler, req) => {
  const out = { status: 200, body: undefined };
  const res = {
    status: (n) => { out.status = n; return res; },
    json: (d) => { out.body = d; },
  };
  await handler({ params: { messageId: String(ROOT_ID) }, query: {}, body: {}, ...req }, res);
  return out;
};

const readPointOf = async (userId, rootId = ROOT_ID) => {
  const { rows } = await mockPool.query(
    'SELECT last_read_at FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2',
    [rootId, String(userId)],
  );
  if (!rows.length) return undefined;
  return rows[0].last_read_at ? new Date(rows[0].last_read_at).toISOString() : null;
};

describe('a thread read point', () => {
  let member;
  let outsider;
  let podId;

  beforeAll(async () => {
    await setupMongoDb();
    await applyTable(mockPool, 'pods');
    await applyTable(mockPool, 'messages');
    await applyTable(mockPool, 'thread_user_state');
    await applyTable(mockPool, 'migration_records');
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await mockPool.query('DELETE FROM thread_user_state');
    await mockPool.query('DELETE FROM messages');
    await mockPool.query('DELETE FROM pods');

    member = await User.create({ username: 'member', email: 'member@example.com', password: 'placeholder' });
    outsider = await User.create({ username: 'outsider', email: 'outsider@example.com', password: 'placeholder' });
    const pod = await Pod.create({ name: 'Mine', type: 'chat', createdBy: member._id, members: [member._id] });
    // A second pod the member does not belong to, with a thread of its own.
    const other = await Pod.create({ name: 'Theirs', type: 'chat', createdBy: outsider._id, members: [outsider._id] });
    podId = String(pod._id);
    const otherPodId = String(other._id);

    await mockPool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1,'Mine','chat',$2), ($3,'Theirs','chat',$4)",
      [podId, String(member._id), otherPodId, String(outsider._id)],
    );
    await mockPool.query(
      "INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1,$2,$3,'root')",
      [ROOT_ID, podId, String(member._id)],
    );
    await mockPool.query(
      "INSERT INTO messages (id, pod_id, user_id, content, thread_root_id) VALUES ($1,$2,$3,'reply',$4)",
      [REPLY_ID, podId, String(member._id), ROOT_ID],
    );
    await mockPool.query(
      "INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1,$2,$3,'their root')",
      [OTHER_ROOT_ID, otherPodId, String(outsider._id)],
    );
    await mockPool.query(
      "INSERT INTO messages (id, pod_id, user_id, content, thread_root_id) VALUES ($1,$2,$3,'their reply',$4)",
      [OTHER_REPLY_ID, otherPodId, String(outsider._id), OTHER_ROOT_ID],
    );
  });

  it('a member sets it, and a reply id resolves to its root', async () => {
    const at = '2026-11-09T10:00:00.000Z';
    const out = await call(setThreadRead, {
      userId: String(member._id), params: { messageId: String(REPLY_ID) }, body: { at },
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ threadRootId: ROOT_ID, lastReadAt: at });
    expect(await readPointOf(member._id)).toBe(at);
  });

  it('refuses a non-member with 403 and writes no row', async () => {
    const out = await call(setThreadRead, {
      userId: String(outsider._id), body: { at: '2026-11-09T10:00:00.000Z' },
    });
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ msg: 'not a member of this pod' });
    expect(await readPointOf(outsider._id)).toBeUndefined();
  });

  it('refuses a root that belongs to another pod: the pod is the message\'s, not the caller\'s', async () => {
    const out = await call(setThreadRead, {
      userId: String(member._id),
      params: { messageId: String(OTHER_ROOT_ID) },
      body: { at: '2026-11-09T10:00:00.000Z' },
    });
    expect(out.status).toBe(403);
    expect(await readPointOf(member._id, OTHER_ROOT_ID)).toBeUndefined();
  });

  it('a message that does not exist is a 404', async () => {
    const out = await call(setThreadRead, {
      userId: String(member._id), params: { messageId: '999' }, body: { at: '2026-11-09T10:00:00.000Z' },
    });
    expect(out.status).toBe(404);
  });

  it.each([
    ['missing', undefined],
    ['a number', 1731146400000],
    ['an empty string', ''],
    ['words', 'yesterday'],
    ['a date with no time', '2026-11-09'],
    ['an impossible date', '2026-13-45T99:00:00Z'],
    ['a day the month does not have', '2026-02-30T10:00:00Z'],
    ['February 29 in a common year', '2026-02-29T10:00:00Z'],
    ['hour 24', '2026-11-09T24:00:00Z'],
    ['an object', { at: '2026-11-09T10:00:00.000Z' }],
  ])('garbage `at` (%s) is a 400 and touches nothing', async (_label, at) => {
    const out = await call(setThreadRead, { userId: String(member._id), body: { at } });
    expect(out.status).toBe(400);
    expect(await readPointOf(member._id)).toBeUndefined();
  });

  it('accepts a real leap day and an offset time', async () => {
    const leap = await call(setThreadRead, { userId: String(member._id), body: { at: '2024-02-29T10:00:00Z' } });
    expect(leap.status).toBe(200);
    const offset = await call(setThreadRead, { userId: String(member._id), body: { at: '2026-11-01T02:00:00-08:00' } });
    expect(offset.status).toBe(200);
    expect(offset.body.lastReadAt).toBe('2026-11-01T10:00:00.000Z');
  });

  it('only moves forward: an older write leaves the newer point in place', async () => {
    const newer = '2026-11-09T10:05:00.000Z';
    const older = '2026-11-09T10:00:00.000Z';
    await call(setThreadRead, { userId: String(member._id), body: { at: newer } });
    const out = await call(setThreadRead, { userId: String(member._id), body: { at: older } });
    expect(out.status).toBe(200);
    expect(out.body.lastReadAt).toBe(newer);
    expect(await readPointOf(member._id)).toBe(newer);

    const later = '2026-11-09T10:09:00.000Z';
    await call(setThreadRead, { userId: String(member._id), body: { at: later } });
    expect(await readPointOf(member._id)).toBe(later);
  });

  it('a point in the future is clamped to now', async () => {
    const before = Date.now();
    await call(setThreadRead, { userId: String(member._id), body: { at: '2999-01-01T00:00:00.000Z' } });
    const stored = Date.parse(await readPointOf(member._id));
    expect(stored).toBeGreaterThanOrEqual(before - 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a read touches neither follow nor collapse', async () => {
    await call(setThreadRead, { userId: String(member._id), body: { at: '2026-11-09T10:00:00.000Z' } });
    const { rows } = await mockPool.query(
      'SELECT following, collapsed FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2',
      [ROOT_ID, String(member._id)],
    );
    expect(rows[0].following).toBeNull();
    expect(rows[0].collapsed).toBe(true);
  });

  it('listThreadState returns lastReadAt: null before the first read, the point after', async () => {
    const read = async () => (await call(listThreadState, {
      userId: String(member._id), query: { podId }, params: {},
    })).body.threads.find((t) => t.threadRootId === ROOT_ID);
    const before = await read();
    expect(before).toHaveProperty('lastReadAt', null);

    const at = '2026-11-09T10:00:00.000Z';
    await call(setThreadRead, { userId: String(member._id), body: { at } });
    expect((await read()).lastReadAt).toBe(at);
  });

  describe('the read-tracking epoch', () => {
    const list = async () => (await call(listThreadState, {
      userId: String(member._id), query: { podId }, params: {},
    })).body;

    afterEach(async () => {
      await mockPool.query('DROP TABLE IF EXISTS schema_migrations');
    });

    it('is null when the runner ledger cannot say, so the client stays quiet', async () => {
      const body = await list();
      expect(body).toHaveProperty('readTrackingSince', null);
      expect(body.threads.length).toBeGreaterThan(0);
    });

    it('is when migration 0011 was applied, read from the runner\'s schema_migrations', async () => {
      // The runner's own DDL (config/run-pg-migrations.ts).
      await mockPool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      const ledger = 'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)';
      await mockPool.query(ledger, ['0010_record_openings.sql', 'x', '2026-11-01T00:00:00Z']);
      expect((await list()).readTrackingSince).toBeNull();
      await mockPool.query(ledger, ['0011_thread_read_point.sql', 'y', '2026-11-10T08:00:00Z']);
      expect((await list()).readTrackingSince).toBe('2026-11-10T08:00:00.000Z');
    });
  });
});
