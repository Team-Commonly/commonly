// The purge deletes production rows, so most arms here are about what it must
// NOT touch: a real user, a look-alike on another domain, a fresh account, a
// pod another human joined, and a seat name someone else holds. Fixtures are
// raw inserts (collection.insertOne) so each arm controls exactly the rows the
// purge can see, independent of model validation.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const Message = require('../../../models/Message');
const AgentRun = require('../../../models/AgentRun');
const ApprovalAction = require('../../../models/ApprovalAction');
const AttentionItem = require('../../../models/AttentionItem');
const AgentMemory = require('../../../models/AgentMemory');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const { perUserInstanceId } = require('../../../services/personaHireService');
const {
  purgeSyntheticAccounts, isSyntheticAccount,
} = require('../../../services/syntheticAccountPurgeService');

const NOW = new Date('2026-10-15T15:00:00Z');
const OLD = new Date('2026-10-15T09:00:00Z');
const id = () => new mongoose.Types.ObjectId();

const insertUser = async (fields) => {
  const doc = { _id: id(), createdAt: OLD, isBot: false, ...fields };
  await User.collection.insertOne(doc);
  return doc;
};

const fakePool = () => {
  const statements = [];
  return {
    statements,
    query: async (sql, params) => {
      statements.push({ sql, params });
      if (/^SELECT count/.test(sql)) return { rows: [{ n: 1 }] };
      return { rows: [], rowCount: 1 };
    },
  };
};

// One synthetic account with the whole footprint a journey run leaves.
const syntheticAccount = async (username = 'eng-smoke-journey-1015124709', { seat = `${username}-claude` } = {}) => {
  const human = await insertUser({ username, email: `${username}@ops.commonly.invalid` });
  const instanceId = perUserInstanceId(String(human._id));
  const scout = await insertUser({
    username: `scout-${instanceId}`, email: `scout-${instanceId}@agents.commonly.local`, isBot: true,
  });
  const seatBot = await insertUser({ username: seat, email: `${seat}@agents.commonly.local`, isBot: true });
  const pod = { _id: id(), name: 'My Workspace', createdBy: human._id, members: [human._id, scout._id, seatBot._id] };
  await Pod.collection.insertOne(pod);
  await Task.collection.insertOne({ podId: pod._id, title: 'starter' });
  await AgentRun.collection.insertOne({ podId: pod._id, agentName: 'scout', instanceId, userId: String(human._id) });
  await ApprovalAction.collection.insertOne({ podId: pod._id, ownerUserId: human._id, actionType: 'connect_local_agent' });
  await AttentionItem.collection.insertOne({ podId: pod._id, recipientUserId: human._id });
  await AgentMemory.collection.insertOne({ agentName: 'scout', instanceId });
  await AgentMemory.collection.insertOne({ agentName: seat, instanceId: 'default' });
  await AgentRegistry.collection.insertOne({ agentName: seat, ephemeral: true, publisher: { userId: human._id } });
  await AgentInstallation.collection.insertOne({ agentName: seat, podId: pod._id, installedBy: human._id });
  await Message.collection.insertOne({ podId: pod._id, userId: scout._id, content: 'Scout fallback opener', createdAt: OLD });
  return { human, scout, seatBot, pod, seat };
};

describe('syntheticAccountPurgeService', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  it('recognises only the journey shape: pattern AND domain AND not a bot', () => {
    expect(isSyntheticAccount({ username: 'eng-smoke-journey-1015124709', email: 'eng-smoke-journey-1015124709@ops.commonly.invalid' })).toBe(true);
    expect(isSyntheticAccount({ username: 'eng-smoke-journey-1015124709', email: 'x@gmail.com' })).toBe(false);
    expect(isSyntheticAccount({ username: 'eng-smoke-1015124709', email: 'a@ops.commonly.invalid' })).toBe(false);
    expect(isSyntheticAccount({ username: 'eng-smoke-journey-1015124709', email: 'a@ops.commonly.invalid', isBot: true })).toBe(false);
  });

  it('preserves a synthetic account promoted to administrator, including its data', async () => {
    const { human, pod, scout } = await syntheticAccount();
    await User.updateOne({ _id: human._id }, { $set: { role: 'admin' } });
    const pool = fakePool();
    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool });
    expect(report.accounts).toHaveLength(0);
    expect(await User.findById(human._id)).not.toBeNull();
    expect(await User.findById(scout._id)).not.toBeNull();
    expect(await Pod.findById(pod._id)).not.toBeNull();
    expect(pool.statements).toHaveLength(0);
  });

  it('uses the administrator mutation lock before an applying purge', async () => {
    const { human } = await syntheticAccount();
    const { withAdminUserMutationLock } = require('../../../services/adminUserMutationService');
    await withAdminUserMutationLock(async () => {
      await expect(purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() }))
        .rejects.toMatchObject({ code: 'ADMIN_MUTATION_BUSY' });
    });
    expect(await User.findById(human._id)).not.toBeNull();
  });

  it('a dry run counts the footprint and deletes nothing', async () => {
    const { human, pod } = await syntheticAccount();
    const report = await purgeSyntheticAccounts({ now: NOW, pool: fakePool() });
    expect(report.dryRun).toBe(true);
    expect(report.accounts).toHaveLength(1);
    expect(report.counts).toMatchObject({ users: 3, tasks: 1, agentruns: 1, agentregistries: 1, pods: 1 });
    expect(await User.countDocuments({ _id: human._id })).toBe(1);
    expect(await Pod.countDocuments({ _id: pod._id })).toBe(1);
    expect(await Message.countDocuments({ podId: pod._id })).toBe(1);
  });

  it('apply removes the account, its bots, pod, seat and linked rows, and leaves everyone else alone', async () => {
    const { human, scout, seatBot, pod, seat } = await syntheticAccount();
    const real = await insertUser({ username: 'priya', email: 'priya@example.com' });
    const lookalike = await insertUser({ username: 'eng-smoke-journey-1015000000', email: 'someone@gmail.com' });
    const fresh = await insertUser({
      username: 'eng-smoke-journey-1015145959', email: 'eng-smoke-journey-1015145959@ops.commonly.invalid',
      createdAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    const community = { _id: id(), name: 'Community', createdBy: real._id, members: [real._id, human._id] };
    await Pod.collection.insertOne(community);
    await Message.collection.insertOne({ podId: community._id, userId: real._id, content: 'Keep this conversation', createdAt: OLD });
    const pool = fakePool();

    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool });

    expect(report.accounts.map((a) => a.username)).toEqual(['eng-smoke-journey-1015124709']);
    for (const gone of [human, scout, seatBot]) expect(await User.countDocuments({ _id: gone._id })).toBe(0);
    expect(await Pod.countDocuments({ _id: pod._id })).toBe(0);
    expect(await Message.countDocuments({ podId: pod._id })).toBe(0);
    expect(await Message.countDocuments({ podId: community._id })).toBe(1);
    expect(await Task.countDocuments({ podId: pod._id })).toBe(0);
    expect(await AgentRun.countDocuments({ podId: pod._id })).toBe(0);
    expect(await ApprovalAction.countDocuments({ ownerUserId: human._id })).toBe(0);
    expect(await AttentionItem.countDocuments({ recipientUserId: human._id })).toBe(0);
    expect(await AgentRegistry.countDocuments({ agentName: seat })).toBe(0);
    expect(await AgentMemory.countDocuments({})).toBe(0);
    // Everyone else is untouched, and the Community pod only lost the synthetic member.
    for (const kept of [real, lookalike, fresh]) expect(await User.countDocuments({ _id: kept._id })).toBe(1);
    const communityAfter = await Pod.findById(community._id).lean();
    expect(communityAfter.members.map(String)).toEqual([String(real._id)]);
    // The PG mirror rows go too: the human, Scout's bot, the seat bot, and the pod's claims.
    const pgDeletes = pool.statements.filter((s) => /^DELETE/.test(s.sql)).map((s) => `${s.sql.split(' WHERE')[0]}:${s.params[0]}`);
    expect(pgDeletes).toEqual(expect.arrayContaining([
      `DELETE FROM users:${human._id}`, `DELETE FROM users:${scout._id}`, `DELETE FROM users:${seatBot._id}`,
      `DELETE FROM message_claims:${pod._id}`, `DELETE FROM pod_members:${human._id}`,
    ]));
    // Idempotent: a second run finds nothing.
    const again = await purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() });
    expect(again.accounts).toHaveLength(0);
  });

  it('refuses an account whose pod another human has joined, and deletes none of it', async () => {
    const { human, pod } = await syntheticAccount();
    const visitor = await insertUser({ username: 'visitor', email: 'visitor@example.com' });
    await Pod.collection.updateOne({ _id: pod._id }, { $push: { members: visitor._id } });

    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() });

    expect(report.accounts[0].refused).toMatch(/another human member/);
    expect(await User.countDocuments({ _id: human._id })).toBe(1);
    expect(await Pod.countDocuments({ _id: pod._id })).toBe(1);
    expect(await Message.countDocuments({ podId: pod._id })).toBe(1);
  });

  it('skips a seat name another user also holds, keeping their install and memory', async () => {
    const { seat } = await syntheticAccount();
    const other = await insertUser({ username: 'dana', email: 'dana@example.com' });
    await AgentInstallation.collection.insertOne({ agentName: seat, podId: id(), installedBy: other._id });

    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() });

    expect(report.accounts[0].skippedSeats).toEqual([{ name: seat, reason: 'installed by another user' }]);
    expect(await AgentInstallation.countDocuments({ agentName: seat, installedBy: other._id })).toBe(1);
    expect(await AgentMemory.countDocuments({ agentName: seat })).toBe(1);
    expect(await AgentRegistry.countDocuments({ agentName: seat })).toBe(1);
  });

  // Registration is open and accepts .invalid, so the selected account may be
  // anyone's. These arms pin that its seat list cannot reach another identity.
  it('skips a seat name without the journey prefix, keeping its bot and memory', async () => {
    const { human, seatBot, seat } = await syntheticAccount('eng-smoke-journey-1015124709', { seat: 'acme-support' });

    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() });

    expect(report.accounts[0].skippedSeats).toEqual([{ name: seat, reason: 'name lacks the journey prefix' }]);
    expect(await User.countDocuments({ _id: human._id })).toBe(0);
    expect(await User.countDocuments({ _id: seatBot._id })).toBe(1);
    expect(await AgentMemory.countDocuments({ agentName: seat })).toBe(1);
    expect(await AgentRegistry.countDocuments({ agentName: seat })).toBe(1);
  });

  it('skips a prefixed seat whose bot user is older than the account', async () => {
    const { seatBot, seat } = await syntheticAccount();
    await User.collection.updateOne({ _id: seatBot._id }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });

    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() });

    expect(report.accounts[0].skippedSeats).toEqual([{ name: seat, reason: 'its bot user predates the account' }]);
    expect(await User.countDocuments({ _id: seatBot._id })).toBe(1);
    expect(await AgentMemory.countDocuments({ agentName: seat })).toBe(1);
  });

  it("deletes only the seat's own (name, 'default') memory, not the same name under another instance", async () => {
    const { seat } = await syntheticAccount();
    await AgentMemory.collection.insertOne({ agentName: seat, instanceId: 'someone-else' });

    await purgeSyntheticAccounts({ apply: true, now: NOW, pool: fakePool() });

    expect(await AgentMemory.countDocuments({ agentName: seat, instanceId: 'default' })).toBe(0);
    expect(await AgentMemory.countDocuments({ agentName: seat, instanceId: 'someone-else' })).toBe(1);
  });
});
