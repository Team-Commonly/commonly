// F660: a pod-target grant is the owner's connection shared with a pod, so it
// lasts only while the owner is a member of that pod. Two layers: the
// membership-ending paths revoke the owner's grants in that pod, and grant use
// refuses one whose owner is no longer a member (rows from before the revoke
// existed, or any path that missed it).
//
// RoomGrant and Pod run on memory Mongo.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const RoomGrant = require('../../../models/RoomGrant');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const roomGrantService = require('../../../services/roomGrantService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const {
  assertGrantUsable, attenuateGrant, endMemberPodGrants, revokeOwnerPodGrants, SYSTEM_REVOKER,
} = roomGrantService;

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

const row = async (grantId) => RoomGrant.findOne({ grantId }).lean();

// The broker's census: the pod's members, as strings (toolBrokerService.currentMemberIds).
const membersOf = async (podId) => ((await Pod.findById(podId).select('members').lean()).members || []).map(String);

describe('a pod grant ends with its owner\'s membership (F660)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await RoomGrant.syncIndexes();
  });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    // Every owner here has an account: a grant whose owner's account is gone is
    // refused before the member check (F664).
    await User.create([
      { _id: CREATOR, username: 'pod-creator', email: 'pod-creator@example.test', password: 'fixture-only' },
      { _id: OWNER, username: 'grant-owner', email: 'grant-owner@example.test', password: 'fixture-only' },
      { _id: OTHER_MEMBER, username: 'other-member', email: 'other-member@example.test', password: 'fixture-only' },
    ]);
    await Pod.create({
      _id: POD, name: 'Pod', type: 'chat', createdBy: CREATOR, members: [CREATOR, OWNER, OTHER_MEMBER, AGENT],
    });
    await Pod.create({
      _id: OTHER_POD, name: 'Other', type: 'chat', createdBy: CREATOR, members: [CREATOR, OWNER, AGENT],
    });
  });

  describe('use-time guard', () => {
    it('refuses a pod grant whose owner left, even when no revoke ran (a row from before the fix)', async () => {
      const grant = await RoomGrant.create(grantFixture());
      await Pod.updateOne({ _id: POD }, { $pull: { members: OWNER } });

      await expect(assertGrantUsable({
        grantId: grant.grantId, agentUserId: String(AGENT), currentMemberIds: await membersOf(POD),
      })).rejects.toMatchObject({ code: 'grant_owner_not_member', statusCode: 403 });
      // The refusal writes nothing: the row is as it was.
      expect((await row(grant.grantId)).revokedAt).toBeNull();
    });

    it('refuses a child of that grant too', async () => {
      const parent = await RoomGrant.create(grantFixture());
      const child = await attenuateGrant({ parentGrantId: parent.grantId, tools: ['github.list_issues'] });
      await Pod.updateOne({ _id: POD }, { $pull: { members: OWNER } });

      await expect(assertGrantUsable({
        grantId: child.grantId, agentUserId: String(AGENT), currentMemberIds: await membersOf(POD),
      })).rejects.toMatchObject({ code: 'grant_owner_not_member' });
    });

    it('a member\'s own grant still works', async () => {
      const grant = await RoomGrant.create(grantFixture());
      await expect(assertGrantUsable({
        grantId: grant.grantId, agentUserId: String(AGENT), currentMemberIds: await membersOf(POD),
      })).resolves.toMatchObject({ grantId: grant.grantId });
    });

    it('the pod creator\'s grant works while they are listed', async () => {
      const grant = await RoomGrant.create(grantFixture({ ownerId: String(CREATOR) }));
      await expect(assertGrantUsable({
        grantId: grant.grantId, agentUserId: String(AGENT), currentMemberIds: await membersOf(POD),
      })).resolves.toBeTruthy();
    });

    it('leaves a seat grant alone: its census is the seat, never the owner', async () => {
      // toolBrokerService.currentMemberIds answers [seat] for a seat target. A
      // seat grant is judged by its owner's account existing instead (F664).
      const grant = await RoomGrant.create(grantFixture({ target: { kind: 'seat', id: String(AGENT) } }));
      await expect(assertGrantUsable({
        grantId: grant.grantId, agentUserId: String(AGENT), currentMemberIds: [String(AGENT)],
      })).resolves.toBeTruthy();
    });

    it('refuses a seat grant whose owner account is gone, and writes nothing (F664)', async () => {
      await User.deleteOne({ _id: OWNER });
      const grant = await RoomGrant.create(grantFixture({ target: { kind: 'seat', id: String(AGENT) } }));
      await expect(assertGrantUsable({
        grantId: grant.grantId, agentUserId: String(AGENT), currentMemberIds: [String(AGENT)],
      })).rejects.toMatchObject({ code: 'grant_owner_deleted', statusCode: 403 });
      expect((await row(grant.grantId)).revokedAt).toBeNull();
    });

    it('does not judge a seat grant with no recorded owner (F664)', async () => {
      const grant = await RoomGrant.create(grantFixture({ target: { kind: 'seat', id: String(AGENT) }, ownerId: null }));
      await expect(assertGrantUsable({
        grantId: grant.grantId, agentUserId: String(AGENT), currentMemberIds: [String(AGENT)],
      })).resolves.toBeTruthy();
    });
  });

  describe('endMemberPodGrants', () => {
    it('revokes the leaver\'s grants in that pod, children included, and nothing else', async () => {
      const mine = await RoomGrant.create(grantFixture());
      const myChild = await attenuateGrant({ parentGrantId: mine.grantId, tools: ['github.list_issues'] });
      const mineElsewhere = await RoomGrant.create(grantFixture({ target: { kind: 'pod', id: String(OTHER_POD) } }));
      const theirs = await RoomGrant.create(grantFixture({ ownerId: String(OTHER_MEMBER) }));
      const mySeat = await RoomGrant.create(grantFixture({ target: { kind: 'seat', id: String(AGENT) } }));

      const revoked = await endMemberPodGrants({ podId: String(POD), userId: String(OWNER) });

      expect(revoked).toBe(2);
      for (const grantId of [mine.grantId, myChild.grantId]) {
        // eslint-disable-next-line no-await-in-loop
        const ended = await row(grantId);
        expect(ended.revokedAt).toBeInstanceOf(Date);
        expect(ended.revokedBy).toBe(SYSTEM_REVOKER);
        expect(ended.revocationReason).toBe('owner_left_pod');
      }
      for (const grantId of [mineElsewhere.grantId, theirs.grantId, mySeat.grantId]) {
        // eslint-disable-next-line no-await-in-loop
        expect((await row(grantId)).revokedAt).toBeNull();
      }
    });

    it('is idempotent: a second run moves nothing and keeps the first stamp', async () => {
      const mine = await RoomGrant.create(grantFixture());
      await endMemberPodGrants({ podId: String(POD), userId: String(OWNER) });
      const first = (await row(mine.grantId)).revokedAt;
      await expect(endMemberPodGrants({ podId: String(POD), userId: String(OWNER) })).resolves.toBe(0);
      expect((await row(mine.grantId)).revokedAt).toEqual(first);
    });

    it('never throws: a failed revoke is logged and answers 0', async () => {
      const spy = jest.spyOn(RoomGrant, 'find').mockImplementationOnce(() => { throw new Error('db down'); });
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(endMemberPodGrants({ podId: String(POD), userId: String(OWNER) })).resolves.toBe(0);
        expect(log).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        log.mockRestore();
      }
    });
  });

  describe('revokeOwnerPodGrants (account deletion)', () => {
    it('without a pod, ends the owner\'s pod grants in every pod, and no seat grant', async () => {
      const here = await RoomGrant.create(grantFixture());
      const there = await RoomGrant.create(grantFixture({ target: { kind: 'pod', id: String(OTHER_POD) } }));
      const seat = await RoomGrant.create(grantFixture({ target: { kind: 'seat', id: String(AGENT) } }));
      const theirs = await RoomGrant.create(grantFixture({ ownerId: String(OTHER_MEMBER) }));

      await expect(revokeOwnerPodGrants({ ownerId: String(OWNER) })).resolves.toBe(2);
      expect((await row(here.grantId)).revokedAt).toBeInstanceOf(Date);
      expect((await row(there.grantId)).revokedAt).toBeInstanceOf(Date);
      expect((await row(seat.grantId)).revokedAt).toBeNull();
      expect((await row(theirs.grantId)).revokedAt).toBeNull();
    });
  });
});
