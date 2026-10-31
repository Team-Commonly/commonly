// A legacy runtime key can sit on another installation of the same identity
// (#2917). Issuing must treat it as existing, so no second live key is minted,
// and must only record the caller as its owner when the caller installed that
// sibling. Real mongod: the sibling lookup relies on a case-insensitive
// collation, which a mocked model cannot exercise.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');

describe('issueRuntimeTokenForAgent with a legacy key on a sibling installation', () => {
  let caller;
  let stranger;
  let podA;
  let podB;

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });

  beforeEach(async () => {
    await clearMongoDb();
    caller = await User.create({ username: 'sib-caller', email: 'sib-caller@test.com', password: 'password123' });
    stranger = await User.create({ username: 'sib-stranger', email: 'sib-stranger@test.com', password: 'password123' });
    podA = await Pod.create({ name: 'a', type: 'chat', createdBy: caller._id, members: [caller._id] });
    podB = await Pod.create({ name: 'b', type: 'chat', createdBy: stranger._id, members: [stranger._id] });
  });

  const installOf = (pod, instanceId, installedBy, runtimeTokens = []) => AgentInstallation.create({
    podId: pod._id, agentName: 'sam-claude', instanceId, version: '1.0.0', installedBy, status: 'active',
    config: { runtime: { runtimeType: 'webhook' } }, runtimeTokens,
  });
  const agentUser = () => User.create({
    username: 'sam-claude-bot', email: 'sam-claude-bot@agents.test', password: 'password123', isBot: true,
    botMetadata: { agentName: 'sam-claude', instanceId: 'work' }, agentRuntimeTokens: [],
  });
  const legacy = (tokenHash) => [{ tokenHash, label: 'legacy', createdAt: new Date() }];

  it('finds a sibling whose instanceId differs only in case', async () => {
    await installOf(podB, 'Work', caller._id, legacy('legacy-mixed-case'));
    const installation = await installOf(podA, 'work', caller._id);
    const result = await issueRuntimeTokenForAgent(await agentUser(), 'BYO', installation, { ownerUserId: caller._id });
    expect(result).toMatchObject({ existing: true });
    expect(result.token).toBeUndefined();
  });

  it('records the caller as owner only of a sibling key the caller installed', async () => {
    await installOf(podB, 'work', caller._id, legacy('own-legacy'));
    const installation = await installOf(podA, 'work', caller._id);
    const result = await issueRuntimeTokenForAgent(await agentUser(), 'BYO', installation, { ownerUserId: caller._id });
    expect(result).toMatchObject({ existing: true });
    const row = await AgentCredential.findOne({ tokenHash: 'own-legacy' }).lean();
    expect(String(row.ownerUserId)).toBe(String(caller._id));
  });

  it('blocks a second mint on another person\'s sibling key without claiming it', async () => {
    await installOf(podB, 'work', stranger._id, legacy('stranger-legacy'));
    const installation = await installOf(podA, 'work', caller._id);
    const result = await issueRuntimeTokenForAgent(await agentUser(), 'BYO', installation, { ownerUserId: caller._id });
    expect(result).toMatchObject({ existing: true });
    expect(result.token).toBeUndefined();
    expect(await AgentCredential.exists({ tokenHash: 'stranger-legacy' })).toBeNull();
    expect(await AgentCredential.countDocuments({ ownerUserId: new mongoose.Types.ObjectId(String(caller._id)) })).toBe(0);
  });
});
