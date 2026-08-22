/**
 * The wake path reads `thread_root_id` off a message it did not construct.
 *
 * 3/4 hooks ambient scoping into `enqueueWakeOnMessage`, and the hook reads
 * `message.thread_root_id`. The controller does `message = (populated ||
 * created)` and hands THAT to `enqueueMentions` — so the object the hook
 * actually receives is `findById`'s row, not `create`'s `RETURNING *`.
 *
 * `findById` projects an explicit column list. `thread_root_id` was missing
 * from it, so the hook read `undefined` for every message and silently never
 * scoped. Every 3/4 test passed throughout, because they build the message
 * object directly with `thread_root_id` set and never travel create →
 * findById. A test that constructs the shape the code under test never
 * receives cannot find a projection bug; only a round trip can.
 *
 * The table comes from schema.sql via `applyTable` rather than being typed
 * here, for the reason in that helper: a hand-written fixture only ever tests
 * the columns you remembered — which is the same class of mistake as the
 * projection this file exists to catch.
 */

const { newDb } = require('pg-mem');
const { applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';

beforeAll(async () => {
  // pods and users come from schema.sql too. Typing them here is how the
  // first attempt failed: hand-written VARCHAR(255) keys against schema.sql's
  // VARCHAR(24) is a foreign-key type mismatch, and the fixture that drifts
  // from the DDL is the thing this helper exists to prevent.
  await applyTable(mockPool, 'pods');
  await applyTable(mockPool, 'users');
  await applyTable(mockPool, 'messages');
  await mockPool.query(
    "INSERT INTO pods (id, name, type, created_by) VALUES ('pod-1', 'P', 'chat', 'user-1')",
  );
  await mockPool.query("INSERT INTO users (_id, username) VALUES ('user-1', 'sam')");
});

describe('findById carries thread_root_id, because the wake path reads it there', () => {
  test('a reply round-trips its derived root through findById', async () => {
    const root = await PGMessage.create(POD, 'user-1', 'root', 'text', null);
    const reply = await PGMessage.create(POD, 'user-1', 'reply', 'text', root.id);

    const read = await PGMessage.findById(reply.id);

    expect(read.thread_root_id).toBe(root.id);
  });

  test('a deep reply too — one hop covers any depth, and the read must show it', async () => {
    const a = await PGMessage.create(POD, 'user-1', 'a', 'text', null);
    const b = await PGMessage.create(POD, 'user-1', 'b', 'text', a.id);
    const c = await PGMessage.create(POD, 'user-1', 'c', 'text', b.id);

    const read = await PGMessage.findById(c.id);

    expect(read.thread_root_id).toBe(a.id);
  });

  test('a root exposes the KEY with a null value, not a missing key', async () => {
    // A missing key and a null read identically to a truthiness check, and the
    // hook is a truthiness check. Only one of them hides a dropped column, so
    // assert on the key rather than on the value being falsy.
    const root = await PGMessage.create(POD, 'user-1', 'lonely', 'text', null);

    const read = await PGMessage.findById(root.id);

    expect(Object.prototype.hasOwnProperty.call(read, 'thread_root_id')).toBe(true);
    expect(read.thread_root_id).toBeNull();
  });

  test('findByPodId carries it too — the same projection, written twice', async () => {
    // Two copies of one column list is why this was missed once already:
    // fixing the one the failing test named leaves the other wrong.
    const root = await PGMessage.create(POD, 'user-1', 'listed root', 'text', null);
    const reply = await PGMessage.create(POD, 'user-1', 'listed reply', 'text', root.id);

    const rows = await PGMessage.findByPodId(POD, 200);
    const read = rows.find((r) => String(r.id) === String(reply.id));

    expect(read.thread_root_id).toBe(root.id);
  });
});
