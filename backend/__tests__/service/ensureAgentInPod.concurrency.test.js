// F605: ensureAgentInPod adds the agent with one conditional write, so a join
// landing between its read and its write (an invite redeem, a direct join)
// cannot put the agent in `members` twice, and the 1:1 DM refusal holds at
// the write itself.
const mongoose = require('mongoose');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// The join policy runs between ensureAgentInPod's pod read and its member
// write, so a hook here lands a concurrent writer inside that window.
let mockInWindow = async () => {};
jest.mock('../../services/outsiderGrantAgentJoinPolicy', () => ({
  assertAgentRuntimeMayJoinPod: jest.fn(async () => mockInWindow()),
  assertInstalledAgentMayJoinPod: jest.fn(async () => mockInWindow()),
}));
jest.mock('../../services/pgMirrorWrite', () => ({
  mirrorMemberAdded: jest.fn().mockResolvedValue(true),
  mirrorUser: jest.fn().mockResolvedValue(true),
}));

const { mirrorMemberAdded } = require('../../services/pgMirrorWrite');
const AgentIdentityService = require('../../services/agentIdentityService');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

let n = 0;
const makeUser = (fields = {}) => {
  n += 1;
  return User.create({
    username: `f605-user-${n}`, email: `f605-${n}@example.test`, password: 'Password123!', ...fields,
  });
};
const makeBot = () => makeUser({ isBot: true, botMetadata: { agentName: 'f605-bot', instanceId: `i${n}` } });
const membersOf = async (podId) => (await Pod.findById(podId).lean()).members.map(String);
// The invite-redeem and joinPod member write.
const inviteJoin = (podId, userId) => Pod.updateOne(
  { _id: podId }, { $addToSet: { members: userId }, $set: { updatedAt: new Date() } },
);

describe('ensureAgentInPod concurrency (F605)', () => {
  let owner;
  beforeAll(setupMongoDb);
  beforeEach(async () => {
    mockInWindow = async () => {};
    mirrorMemberAdded.mockClear();
    owner = await makeUser();
  });
  afterEach(clearMongoDb);
  afterAll(closeMongoDb);

  it('an invite join racing ensureAgentInPod for the same bot leaves it in members once', async () => {
    const bot = await makeBot();
    const pod = await Pod.create({ name: 'race', type: 'chat', createdBy: owner._id });
    const reached = deferred();
    const joined = deferred();
    mockInWindow = async () => { reached.resolve(); await joined.promise; };

    const ensuring = AgentIdentityService.ensureAgentInPod(bot, pod._id);
    const joining = reached.promise
      .then(() => inviteJoin(pod._id, bot._id))
      .then(() => joined.resolve());
    const [result] = await Promise.all([ensuring, joining]);

    const members = await membersOf(pod._id);
    expect(members.filter((m) => m === String(bot._id))).toHaveLength(1);
    expect(members).toHaveLength(2);
    // The caller still gets the pod with the bot in it.
    expect(result.members.map(String)).toContain(String(bot._id));
    // The join that won the race mirrors its own add; ensureAgentInPod adds nothing.
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
  });

  it('a different member added concurrently survives alongside the bot', async () => {
    const bot = await makeBot();
    const other = await makeUser();
    const pod = await Pod.create({ name: 'lost-update', type: 'chat', createdBy: owner._id });
    const reached = deferred();
    const joined = deferred();
    mockInWindow = async () => { reached.resolve(); await joined.promise; };

    const ensuring = AgentIdentityService.ensureAgentInPod(bot, pod._id);
    const joining = reached.promise
      .then(() => inviteJoin(pod._id, other._id))
      .then(() => joined.resolve());
    await Promise.all([ensuring, joining]);

    expect((await membersOf(pod._id)).sort())
      .toEqual([String(owner._id), String(other._id), String(bot._id)].sort());
    expect(mirrorMemberAdded).toHaveBeenCalledTimes(1);
    expect(mirrorMemberAdded).toHaveBeenCalledWith(String(pod._id), String(bot._id));
  });

  it('two bots racing into a DM with one human are both refused; the DM never widens', async () => {
    const [botA, botB] = [await makeBot(), await makeBot()];
    const pod = await Pod.create({ name: 'dm', type: 'agent-room', createdBy: owner._id });
    expect(await membersOf(pod._id)).toHaveLength(1);

    const results = await Promise.all([
      AgentIdentityService.ensureAgentInPod(botA, pod._id),
      AgentIdentityService.ensureAgentInPod(botB, pod._id),
    ]);

    expect(results).toEqual([null, null]);
    expect(await membersOf(pod._id)).toEqual([String(owner._id)]);
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
  });

  it('a pod that becomes a 1:1 DM between the read and the write refuses the add', async () => {
    const bot = await makeBot();
    const human = await makeUser();
    const pod = await Pod.create({ name: 'flip', type: 'chat', createdBy: owner._id });
    mockInWindow = async () => {
      await Pod.updateOne(
        { _id: pod._id }, { $set: { type: 'agent-dm' }, $addToSet: { members: human._id } },
      );
    };

    const result = await AgentIdentityService.ensureAgentInPod(bot, pod._id);

    expect(result).toBeNull();
    expect((await membersOf(pod._id)).sort()).toEqual([String(owner._id), String(human._id)].sort());
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
  });

  it('a pod deleted between the read and the write returns null and adds nothing', async () => {
    const bot = await makeBot();
    const pod = await Pod.create({ name: 'gone', type: 'chat', createdBy: owner._id });
    mockInWindow = async () => { await Pod.deleteOne({ _id: pod._id }); };

    await expect(AgentIdentityService.ensureAgentInPod(bot, pod._id)).resolves.toBeNull();
    expect(await Pod.countDocuments({ _id: pod._id })).toBe(0);
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
  });

  it('a stale whole-array save (removeAgentFromPod shape) cannot silently undo the atomic add', async () => {
    const bot = await makeBot();
    const other = await makeUser();
    const pod = await Pod.create({ name: 'stale', type: 'chat', createdBy: owner._id });
    await inviteJoin(pod._id, other._id);
    // Loaded before the add, as a concurrent removeAgentFromPod would hold it.
    const stale = await Pod.findById(pod._id);

    await AgentIdentityService.ensureAgentInPod(bot, pod._id);
    stale.members = stale.members.filter((m) => String(m) !== String(other._id));

    await expect(stale.save()).rejects.toHaveProperty('name', 'VersionError');
    expect((await membersOf(pod._id)).sort())
      .toEqual([String(owner._id), String(other._id), String(bot._id)].sort());
  });

  it('an agent already in the pod is a no-op that returns the pod', async () => {
    const bot = await makeBot();
    const pod = await Pod.create({ name: 'member', type: 'agent-room', createdBy: owner._id });
    await inviteJoin(pod._id, bot._id);
    const updateOne = jest.spyOn(Pod, 'updateOne');
    try {
      const result = await AgentIdentityService.ensureAgentInPod(bot, pod._id);
      expect(String(result._id)).toBe(String(pod._id));
      expect(result.members.map(String)).toEqual([String(owner._id), String(bot._id)]);
      expect(updateOne).not.toHaveBeenCalled();
    } finally {
      updateOne.mockRestore();
    }
    expect(await membersOf(pod._id)).toEqual([String(owner._id), String(bot._id)]);
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
  });

  it('a plain add writes the bot once, mirrors it once, and returns the pod with the bot', async () => {
    const bot = await makeBot();
    const pod = await Pod.create({ name: 'plain', type: 'chat', createdBy: owner._id });
    const result = await AgentIdentityService.ensureAgentInPod(bot, new mongoose.Types.ObjectId(String(pod._id)));
    expect(result.members.map(String)).toEqual([String(owner._id), String(bot._id)]);
    expect(await membersOf(pod._id)).toEqual([String(owner._id), String(bot._id)]);
    expect(mirrorMemberAdded).toHaveBeenCalledTimes(1);
  });
});
