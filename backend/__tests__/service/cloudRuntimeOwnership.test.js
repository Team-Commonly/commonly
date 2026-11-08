// A cloud agent runs only while the account that installed it may. Real Mongo.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { cloudRuntimeMayRun, clearCloudRuntimeCache } = require('../../services/cloudRuntimeOwnership');

describe('cloudRuntimeMayRun', () => {
  let n = 0;
  const person = (over = {}) => {
    n += 1;
    return User.create({ username: `p${n}`, email: `p${n}@test.com`, password: 'password123', ...over });
  };
  const row = (installedBy, config, over = {}) => AgentInstallation.create({
    agentName: 'helper', instanceId: 'default', podId: new mongoose.Types.ObjectId(), version: '1',
    installedBy, status: 'active', config, ...over,
  });
  const native = { runtime: { runtimeType: 'native' } };

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    clearCloudRuntimeCache();
  });

  it('stops an agent whose installer has lost the entitlement', async () => {
    const owner = await person({ entitlements: { cloudAgents: true } });
    await row(owner._id, native);
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
    await User.updateOne({ _id: owner._id }, { $set: { 'entitlements.cloudAgents': false } });
    clearCloudRuntimeCache();
    expect(await cloudRuntimeMayRun('helper')).toBe(false);
  });

  it('lets an admin\'s agent run, and stops it when the role goes', async () => {
    const admin = await person({ role: 'admin' });
    await row(admin._id, native);
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
    await User.updateOne({ _id: admin._id }, { $set: { role: 'user' } });
    clearCloudRuntimeCache();
    expect(await cloudRuntimeMayRun('helper')).toBe(false);
  });

  it('never lets a DM projection decide: the person who opened it is not the owner', async () => {
    const admin = await person({ role: 'admin' });
    const visitor = await person();
    await row(admin._id, native);
    await row(visitor._id, { ...native, autoJoinSource: 'agent-room' });
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
    // A projection alone, with its owner's row gone, gates nothing.
    await AgentInstallation.deleteMany({ installedBy: admin._id });
    clearCloudRuntimeCache();
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
  });

  it('leaves a first-party auto-install with no runtime alone', async () => {
    const creator = await person();
    await row(creator._id, { autoInstalled: true });
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
  });

  it('leaves a BYO agent alone', async () => {
    const creator = await person();
    await row(creator._id, { runtime: { runtimeType: 'webhook' } });
    await row(creator._id, { runtime: { runtimeType: 'codex', host: 'byo' } });
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
  });

  it('lets a system install by a bot run', async () => {
    const bot = await person({ isBot: true });
    await row(bot._id, native);
    expect(await cloudRuntimeMayRun('helper')).toBe(true);
  });

  it('gates a paused row too, so resuming it does not bring the agent back', async () => {
    const owner = await person();
    await row(owner._id, { runtime: { runtimeType: 'moltbot' } }, { status: 'paused' });
    expect(await cloudRuntimeMayRun('helper')).toBe(false);
  });

  it('ends a revoked owner\'s native turn as no action, before any model call', async () => {
    // eslint-disable-next-line global-require
    const { runAgent } = require('../../services/nativeRuntimeService');
    const owner = await person();
    const install = await row(owner._id, native);
    const result = await runAgent(install.toObject(), { type: 'chat.mention', eventId: '', payload: {} });
    expect(result).toMatchObject({ status: 'succeeded', totalTurns: 0, noActionReason: 'cloud_agents_not_entitled' });
  });
});
