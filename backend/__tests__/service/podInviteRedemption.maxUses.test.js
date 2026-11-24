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

// Holds every redemption at its pod lookup, which comes after the isUsable()
// read and before the claim, until `count` of them have read the pod. No
// redemption goes on until every one has its pod, so none can join before
// another reads the members.
const holdAtPodLookup = (count, onRelease = async () => {}) => {
  const findById = Pod.findById.bind(Pod);
  let arrived = 0;
  let release;
  const allArrived = new Promise((resolve) => { release = resolve; });
  return jest.spyOn(Pod, 'findById').mockImplementation(async (...args) => {
    const doc = await findById(...args);
    arrived += 1;
    if (arrived === count) onRelease().then(release);
    await allArrived;
    return doc;
  });
};
// Holds every member add (the Pod.updateOne whose filter names `members`)
// until `count` of them have arrived, so all of them race the add itself.
const holdAtMemberAdd = (count) => {
  const updateOne = Pod.updateOne.bind(Pod);
  let arrived = 0;
  let release;
  const allArrived = new Promise((resolve) => { release = resolve; });
  return jest.spyOn(Pod, 'updateOne').mockImplementation(async (filter, ...rest) => {
    if (filter && 'members' in filter) {
      arrived += 1;
      if (arrived === count) release();
      await allArrived;
    }
    return updateOne(filter, ...rest);
  });
};
// A give-back is the update that takes a use away again.
const isGiveBack = (update) => update?.$inc?.useCount === -1;

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
    const hold = holdAtPodLookup(2);
    let results;
    try {
      results = await Promise.all([
        redeemPodInvite(invite.token, a._id), redeemPodInvite(invite.token, b._id),
      ]);
    } finally {
      hold.mockRestore();
    }

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
    const save = jest.spyOn(Pod, 'updateOne').mockRejectedValueOnce(new Error('write failed'));
    try {
      await expect(redeemPodInvite(invite.token, a._id)).rejects.toThrow('write failed');
    } finally {
      save.mockRestore();
    }
    expect(await uses(invite)).toBe(0);
    expect(await members()).not.toContain(String(a._id));
  });

  test('a join that fails to save retries a failed give-back until it lands', async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const a = await person();
    const save = jest.spyOn(Pod, 'updateOne').mockRejectedValueOnce(new Error('write failed'));
    const updateOne = PodInvite.updateOne.bind(PodInvite);
    let giveBacks = 0;
    const update = jest.spyOn(PodInvite, 'updateOne').mockImplementation((filter, change, ...rest) => {
      if (isGiveBack(change)) {
        giveBacks += 1;
        if (giveBacks === 1) return Promise.reject(new Error('db down'));
      }
      return updateOne(filter, change, ...rest);
    });
    try {
      await expect(redeemPodInvite(invite.token, a._id)).rejects.toThrow('write failed');
    } finally {
      save.mockRestore();
      update.mockRestore();
    }
    expect(giveBacks).toBe(2);
    expect(await uses(invite)).toBe(0);
  });

  test('a give-back that fails every try is logged with the invite id; the join error is thrown', async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const a = await person();
    const save = jest.spyOn(Pod, 'updateOne').mockRejectedValueOnce(new Error('write failed'));
    const updateOne = PodInvite.updateOne.bind(PodInvite);
    let giveBacks = 0;
    const update = jest.spyOn(PodInvite, 'updateOne').mockImplementation((filter, change, ...rest) => {
      if (isGiveBack(change)) {
        giveBacks += 1;
        return Promise.reject(new Error('db down'));
      }
      return updateOne(filter, change, ...rest);
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(redeemPodInvite(invite.token, a._id)).rejects.toThrow('write failed');
      expect(giveBacks).toBe(3);
      const lines = error.mock.calls.map((args) => args.join(' '));
      expect(lines.filter((l) => l.includes(String(invite._id)))).toHaveLength(1);
      expect(lines.join('\n')).toContain(String(pod._id));
      expect(lines.join('\n')).not.toContain(String(a._id));
    } finally {
      save.mockRestore();
      update.mockRestore();
      error.mockRestore();
    }
    expect(await uses(invite)).toBe(1);
  });

  test.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('an invite %s after the usability read refuses at the claim, without joining', async (_label, change) => {
    const invite = await makeInvite({ maxUses: 5 });
    const a = await person();
    const hold = holdAtPodLookup(1, () => PodInvite.updateOne({ _id: invite._id }, { $set: change }));
    let result;
    try {
      result = await redeemPodInvite(invite.token, a._id);
    } finally {
      hold.mockRestore();
    }
    expect(result).toEqual(REFUSED);
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

describe('redeemPodInvite joins one user once (F604)', () => {
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

  // Both redemptions read the pod before either goes on; with `bothAdd`, both
  // also reach the member add before either writes (only when the invite has
  // room for both claims).
  const redeemTwiceAtOnce = async (invite, user, { bothAdd = false } = {}) => {
    const hold = holdAtPodLookup(2);
    const add = bothAdd ? holdAtMemberAdd(2) : null;
    try {
      return await Promise.all([
        redeemPodInvite(invite.token, user._id), redeemPodInvite(invite.token, user._id),
      ]);
    } finally {
      hold.mockRestore();
      add?.mockRestore();
    }
  };

  test('the same person redeeming twice at once joins once and spends one use', async () => {
    const invite = await makeInvite({ maxUses: 5 });
    const a = await person();
    const results = await redeemTwiceAtOnce(invite, a, { bothAdd: true });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.alreadyMember).sort()).toEqual([false, true]);
    results.forEach((r) => expect(r.pod.members.map(String)).toContain(String(a._id)));
    expect((await members()).filter((m) => m === String(a._id))).toHaveLength(1);
    expect(await uses(invite)).toBe(1);
  });

  test('the same person redeeming a one-use invite twice at once joins once', async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const a = await person();
    const results = await redeemTwiceAtOnce(invite, a);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await members()).filter((m) => m === String(a._id))).toHaveLength(1);
    expect(await uses(invite)).toBe(1);
  });

  test('a person who joined another way during the redemption gives the use back', async () => {
    const invite = await makeInvite({ maxUses: 5 });
    const a = await person();
    const { mirrorMemberAdded } = require('../../services/pgMirrorWrite');
    mirrorMemberAdded.mockClear();
    // The pod is read, then the person joins another way before the claim.
    const findById = Pod.findById.bind(Pod);
    const lookup = jest.spyOn(Pod, 'findById').mockImplementationOnce(async (...args) => {
      const doc = await findById(...args);
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: a._id } });
      return doc;
    });
    let result;
    try {
      result = await redeemPodInvite(invite.token, a._id);
    } finally {
      lookup.mockRestore();
    }
    expect(result).toMatchObject({ ok: true, alreadyMember: true });
    expect((await members()).filter((m) => m === String(a._id))).toHaveLength(1);
    expect(await uses(invite)).toBe(0);
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
    expect((await PodInvite.findById(invite._id).lean()).firstTeammateJoinedAt).toBeUndefined();
  });
});

describe('redeemPodInvite members and vanished pods', () => {
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

  test('a member opening a one-use invite spends no use, so a newcomer still can', async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const result = await redeemPodInvite(invite.token, owner._id);
    expect(result).toMatchObject({ ok: true, alreadyMember: true });
    expect(await uses(invite)).toBe(0);

    const a = await person();
    expect(await redeemPodInvite(invite.token, a._id)).toMatchObject({ ok: true, alreadyMember: false });
    expect(await uses(invite)).toBe(1);
    expect(await members()).toContain(String(a._id));
  });

  test('a pod deleted between the lookup and the join refuses as not found and gives the use back', async () => {
    const invite = await makeInvite({ maxUses: 5 });
    const a = await person();
    const findById = Pod.findById.bind(Pod);
    const lookup = jest.spyOn(Pod, 'findById').mockImplementationOnce(async (...args) => {
      const doc = await findById(...args);
      await Pod.deleteOne({ _id: pod._id });
      return doc;
    });
    let result;
    try {
      result = await redeemPodInvite(invite.token, a._id);
    } finally {
      lookup.mockRestore();
    }
    expect(result).toEqual({ ok: false, status: 404, body: { msg: 'Pod no longer exists' } });
    expect(await uses(invite)).toBe(0);
  });
});
