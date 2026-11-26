// F660: leaving a pod, or being removed from it, ends the pod-target grants the
// person owns in that pod. The revoke is best-effort: it never fails the leave,
// because the use-time guard (roomGrantService.assertGrantUsable) refuses a
// departed owner's grant whatever happened here.
//
// Real controller, Pod and RoomGrant on memory Mongo.
process.env.PG_HOST = '';
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const podController = require('../../../controllers/podController');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const RoomGrant = require('../../../models/RoomGrant');
const roomGrantService = require('../../../services/roomGrantService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const id = () => new mongoose.Types.ObjectId();
const CREATOR = id();
const OWNER = id();
const OTHER_MEMBER = id();
const AGENT = id();
const POD = id();
const OTHER_POD = id();

const grantFixture = (overrides = {}) => ({
  grantId: `grant_${id().toString()}`,
  connectionId: id().toString(),
  installationId: 'install-1',
  target: { kind: 'pod', id: String(POD) },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [String(AGENT)],
  expiresAt: new Date(Date.now() + 3_600_000),
  brokerId: 'github-app',
  ownerId: String(OWNER),
  ...overrides,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

const revokedAt = async (grantId) => (await RoomGrant.findOne({ grantId }).lean()).revokedAt;

describe('podController ends a member\'s pod grants with their membership (F660)', () => {
  let mine; let mineElsewhere; let theirs;

  beforeAll(async () => {
    await setupMongoDb();
    await RoomGrant.syncIndexes();
  });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    await Pod.create({
      _id: POD, name: 'Pod', type: 'chat', createdBy: CREATOR, members: [CREATOR, OWNER, OTHER_MEMBER, AGENT],
    });
    await Pod.create({
      _id: OTHER_POD, name: 'Other', type: 'chat', createdBy: CREATOR, members: [CREATOR, OWNER, AGENT],
    });
    mine = await RoomGrant.create(grantFixture());
    mineElsewhere = await RoomGrant.create(grantFixture({ target: { kind: 'pod', id: String(OTHER_POD) } }));
    theirs = await RoomGrant.create(grantFixture({ ownerId: String(OTHER_MEMBER) }));
  });

  it('leave revokes the leaver\'s grants in that pod only', async () => {
    const res = mockRes();
    await podController.leavePod({ params: { id: String(POD) }, userId: String(OWNER) }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(await revokedAt(mine.grantId)).toBeInstanceOf(Date);
    expect(await revokedAt(mineElsewhere.grantId)).toBeNull();
    expect(await revokedAt(theirs.grantId)).toBeNull();
  });

  it('removal by the pod creator revokes the removed member\'s grants in that pod', async () => {
    const res = mockRes();
    await podController.removeMember(
      { params: { id: String(POD), memberId: String(OWNER) }, userId: String(CREATOR) },
      res,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(await revokedAt(mine.grantId)).toBeInstanceOf(Date);
    expect(await revokedAt(mineElsewhere.grantId)).toBeNull();
    expect(await revokedAt(theirs.grantId)).toBeNull();
  });

  it('a refused removal revokes nothing', async () => {
    const res = mockRes();
    await podController.removeMember(
      { params: { id: String(POD), memberId: String(OWNER) }, userId: String(OTHER_MEMBER) },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(await revokedAt(mine.grantId)).toBeNull();
  });

  it('leaving never fails because the revoke failed', async () => {
    const spy = jest.spyOn(RoomGrant, 'find').mockImplementation(() => { throw new Error('db down'); });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = mockRes();
      await podController.leavePod({ params: { id: String(POD) }, userId: String(OWNER) }, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
      const pod = await Pod.findById(POD).lean();
      expect(pod.members.map(String)).not.toContain(String(OWNER));
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
    // The grant the failed revoke missed is still refused at use. The owner's
    // account exists, so the member check is what refuses it.
    await User.create({ _id: OWNER, username: 'grant-owner', email: 'grant-owner@example.test', password: 'fixture-only' });
    await expect(roomGrantService.assertGrantUsable({
      grantId: mine.grantId,
      agentUserId: String(AGENT),
      currentMemberIds: (await Pod.findById(POD).lean()).members.map(String),
    })).rejects.toMatchObject({ code: 'grant_owner_not_member' });
  });
});
