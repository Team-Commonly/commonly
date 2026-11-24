// F603: redeeming a pod invite counts the use with one conditional update, so
// two redemptions at once cannot both pass the maxUses check and overrun it.
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { PodInvite } = require('../../models/PodInvite');
const { redeemPodInvite } = require('../../services/podInviteRedemption');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../services/pgMirrorWrite', () => ({ mirrorMemberAdded: jest.fn().mockResolvedValue(undefined) }));

const REFUSED = { ok: false, status: 404, body: { msg: 'Invite invalid or expired' } };

let owner;
let pod;
let n = 0;

const person = async () => {
  n += 1;
  return User.create({
    username: `joiner-${n}`, email: `joiner-${n}@example.com`, password: 'Password123!', verified: true,
  });
};
const makeInvite = (fields) => {
  n += 1;
  return PodInvite.create({
    token: n.toString(16).padStart(32, '0'), podId: pod._id, createdBy: owner._id, ...fields,
  });
};
const members = async () => (await Pod.findById(pod._id).lean()).members.map(String);
const uses = async (invite) => (await PodInvite.findById(invite._id).lean()).useCount;

describe('redeemPodInvite counts uses atomically (F603)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    owner = await User.create({
      username: 'owner', email: 'owner@example.com', password: 'Password123!', verified: true,
    });
    pod = await Pod.create({
      name: 'Team room', type: 'chat', createdBy: owner._id, members: [owner._id],
    });
  });
  afterEach(clearMongoDb);

  test('two redemptions at once of an invite with one use left: exactly one joins', async () => {
    const invite = await makeInvite({ maxUses: 3, useCount: 2 });
    const a = await person();
    const b = await person();
    const results = await Promise.all([
      redeemPodInvite(invite.token, a._id), redeemPodInvite(invite.token, b._id),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual(REFUSED);
    expect(await uses(invite)).toBe(3);
    const joined = (await members()).filter((m) => [String(a._id), String(b._id)].includes(m));
    expect(joined).toHaveLength(1);
  });

  test('an unlimited invite counts both of two redemptions at once', async () => {
    const invite = await makeInvite({});
    const a = await person();
    const b = await person();
    const results = await Promise.all([
      redeemPodInvite(invite.token, a._id), redeemPodInvite(invite.token, b._id),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(await uses(invite)).toBe(2);
    expect(await members()).toEqual(expect.arrayContaining([String(a._id), String(b._id)]));
  });

  test('a single redemption joins, counts one use and stamps lastUsedAt', async () => {
    const invite = await makeInvite({ maxUses: 5 });
    const a = await person();
    const result = await redeemPodInvite(invite.token, a._id);

    expect(result).toMatchObject({ ok: true, alreadyMember: false });
    const saved = await PodInvite.findById(invite._id).lean();
    expect(saved.useCount).toBe(1);
    expect(saved.lastUsedAt).toBeInstanceOf(Date);
    expect(await members()).toContain(String(a._id));
  });

  test('a join that fails to save gives its counted use back', async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const a = await person();
    const save = jest.spyOn(Pod.prototype, 'save').mockRejectedValueOnce(new Error('write failed'));
    try {
      await expect(redeemPodInvite(invite.token, a._id)).rejects.toThrow('write failed');
    } finally {
      save.mockRestore();
    }
    expect(await uses(invite)).toBe(0);
    expect(await members()).not.toContain(String(a._id));
  });

  test.each([
    ['used up', { maxUses: 1, useCount: 1 }],
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('refuses an invite that is %s, without counting or joining', async (_label, fields) => {
    const invite = await makeInvite(fields);
    const a = await person();
    expect(await redeemPodInvite(invite.token, a._id)).toEqual(REFUSED);
    expect(await uses(invite)).toBe(fields.useCount || 0);
    expect(await members()).not.toContain(String(a._id));
  });
});
