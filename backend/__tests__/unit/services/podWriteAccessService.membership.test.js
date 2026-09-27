// TASK-162, second site. `callerHasPodWriteAccess` is the write gate for the
// dual-auth endpoints (reactions, thread state) and it used to read the PG
// `pod_members` mirror FIRST, returning true on a row alone. The mirror is not
// authoritative: `PGPod.create` inserts the owner unconditionally and
// `syncPodFromMongo` backfills Mongo's `createdBy`, so a row outlives the
// membership. Production had 77 such rows, 36 of them the pod's own creator
// (Vera 74648).
//
// The arm that discriminates is the SURVIVOR — the row still there, Mongo
// membership gone — because "leave, then write is refused" also passes while
// the row is absent, which is the state a mirror-only fix would produce.
//
// The PG pool is a real pg-mem instance holding a real row, so the ghost is a
// fixture rather than a mock's opinion; if someone reinstates the PG fast path
// this suite grants with it.

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const mongoose = require('mongoose');

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { callerHasPodWriteAccess, getCallerId } = require('../../../services/podWriteAccessService');

jest.mock('../../../models/Pod');
jest.mock('../../../models/AgentRegistry');

const podId = new mongoose.Types.ObjectId().toString();
const memberId = new mongoose.Types.ObjectId().toString();
const departedId = new mongoose.Types.ObjectId().toString();
const outsiderId = new mongoose.Types.ObjectId().toString();

const humanReq = (id) => ({ userId: id, user: { _id: id } });

const mongoPod = (doc) => {
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
  });
};

const seedPgRow = async (userId) => {
  await mockPool.query('INSERT INTO pod_members (pod_id, user_id) VALUES ($1, $2)', [podId, userId]);
};

const pgRowCount = async (userId) => {
  const r = await mockPool.query('SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2', [podId, userId]);
  return r.rows.length;
};

const installationFound = (found) => {
  AgentInstallation.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(found ? { _id: 'i1' } : null) });
};

describe('pod write access reads Mongo membership, never the PG mirror (TASK-162)', () => {
  beforeAll(async () => {
    await mockPool.query('CREATE TABLE pod_members (pod_id text, user_id text, PRIMARY KEY (pod_id, user_id))');
  });

  beforeEach(async () => {
    await mockPool.query('DELETE FROM pod_members');
    jest.clearAllMocks();
    installationFound(false);
  });

  test('refuses a caller whose PG row outlived their membership', async () => {
    // The survivor, and the whole point: the mirror says yes, Mongo says no.
    await seedPgRow(departedId);
    mongoPod({ members: [memberId] });

    await expect(callerHasPodWriteAccess(podId, departedId, humanReq(departedId))).resolves.toBe(false);
    // Control on the fixture itself: the row really is present, so a false here
    // is the membership rule and not an empty table.
    await expect(pgRowCount(departedId)).resolves.toBe(1);
  });

  test('refuses a departed CREATOR whose PG row is present', async () => {
    // Two clauses at once: the stale row, and the permissive creator bypass that
    // TASK-161 removed from the connector path. Neither may reach this gate.
    await seedPgRow(departedId);
    mongoPod({ createdBy: departedId, members: [memberId] });

    await expect(callerHasPodWriteAccess(podId, departedId, humanReq(departedId))).resolves.toBe(false);
  });

  test('refuses a caller for a pod Mongo no longer has, whatever PG holds', async () => {
    await seedPgRow(outsiderId);
    mongoPod(null);

    await expect(callerHasPodWriteAccess(podId, outsiderId, humanReq(outsiderId))).resolves.toBe(false);
  });

  test('admits a listed member, and leaves the mirror alone rather than needing it', async () => {
    mongoPod({ members: [memberId] });

    await expect(callerHasPodWriteAccess(podId, memberId, humanReq(memberId))).resolves.toBe(true);
    await expect(pgRowCount(memberId)).resolves.toBe(0);
  });

  test('admits an agent caller through its active installation, before any membership read', async () => {
    installationFound(true);
    mongoPod({ members: [] });

    await expect(callerHasPodWriteAccess(podId, departedId, { agentUser: { _id: departedId } })).resolves.toBe(true);
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  test('refuses an agent caller with no installation and no Mongo membership', async () => {
    installationFound(false);
    mongoPod({ members: [memberId] });

    await expect(callerHasPodWriteAccess(podId, departedId, { agentUser: { _id: departedId } })).resolves.toBe(false);
  });

  test('refuses a member entry in a shape `createMessage` would also refuse', async () => {
    // The narrowing this row makes visible. `models/Pod.ts:157` stores
    // `members` as ObjectIds and `createMessage` compares
    // `memberId.toString() === userIdStr`, so a `{ userId }` entry is not a
    // membership the pod's own write path accepts — and this gate read it as
    // one (`m?.userId?.toString?.() || m`). The arm states the divergence
    // rather than leaving it implied, so if production turns out to hold such
    // entries the arm gets inverted with the census that says so.
    mongoPod({ members: [{ userId: { toString: () => memberId } }] });

    await expect(callerHasPodWriteAccess(podId, memberId, humanReq(memberId))).resolves.toBe(false);
  });

  test('refuses an agent fallback in that same shape, so both branches hold one rule', async () => {
    // The agent branch had its own inline copy of the membership test, and the
    // copy — not the rule — was what honoured `{ userId }`. Both branches now
    // read the same predicate, so this arm is the second half of the narrowing
    // above: a shape `createMessage` refuses is refused here whichever auth
    // path the caller used.
    installationFound(false);
    mongoPod({ members: [{ userId: { toString: () => departedId } }] });

    await expect(callerHasPodWriteAccess(podId, departedId, { agentUser: { _id: departedId } })).resolves.toBe(false);
  });

  test('getCallerId reads the agent shape too, not just req.user/req.userId', async () => {
    expect(getCallerId({ agentUser: { _id: 'a1' } })).toBe('a1');
  });
});
