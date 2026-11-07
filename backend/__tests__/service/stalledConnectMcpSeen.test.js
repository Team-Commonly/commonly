// A real mongod because the claim is the round trip: `lastMcpSeenAt` written by
// the auth stamp, through each token store's own schema, and read back through
// the scan's own projection. A mock of `updateOne` can't tell whether the field
// persists, or whether the projection still carries it.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const mockPost = jest.fn();
jest.mock('../../services/agentMessageService', () => ({ postMessage: (...args) => mockPost(...args) }));

const { AgentInstallation } = require('../../models/AgentRegistry');
const StalledConnectEpisode = require('../../models/StalledConnectEpisode');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { usageStamp } = require('../../middleware/agentRuntimeAuth');
const { scan } = require('../../services/stalledConnectService');

const MINUTE = 60 * 1000;
// The real clock, because usageStamp stamps with it.
const NOW = new Date();
const ISSUED = new Date(NOW.getTime() - 20 * MINUTE);
const mcpClient = { headers: { 'user-agent': 'commonly-mcp/1.0.0' } };
const otherClient = { headers: { 'user-agent': 'node' } };

const seat = async (agentName, runtimeTokens) => AgentInstallation.create({
  agentName,
  instanceId: 'default',
  podId: new mongoose.Types.ObjectId(),
  version: '1.0.0',
  installedBy: (await User.create({
    username: `${agentName}-person`, email: `${agentName}@people.test`, password: 'not-a-login',
  }))._id,
  status: 'active',
  config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
  runtimeTokens,
});

const botRow = (agentName, tokens) => User.create({
  username: `${agentName}-bot`,
  email: `${agentName}@agents.test`,
  password: 'not-a-login',
  isBot: true,
  botMetadata: { agentName, instanceId: 'default' },
  agentRuntimeTokens: tokens,
});

describe('a seat that an MCP client has used hears the MCP close, not the nudge', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    mockPost.mockReset();
    mockPost.mockResolvedValue({ success: true, message: { id: 'm1' } });
  });

  it('nudges the owner, not a guest whose room row names them', async () => {
    const owner = await User.create({ username: 'dana', email: 'dana@people.test', password: 'not-a-login' });
    const guest = await User.create({ username: 'river', email: 'river@people.test', password: 'not-a-login' });
    const bot = await botRow('dana-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
    const runtime = { runtime: { host: 'byo', runtimeType: 'local-cli' } };
    const row = (podId, installedBy) => AgentInstallation.create({
      agentName: 'dana-agent', instanceId: 'default', podId, version: '1.0.0', installedBy, status: 'active', config: runtime,
    });
    const room = await Pod.create({ name: 'Dana agent', type: 'agent-room', createdBy: guest._id, members: [guest._id, bot._id] });
    const team = await Pod.create({ name: 'Team', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await row(room._id, guest._id);
    await row(team._id, owner._id);

    await scan({ now: NOW });
    expect(mockPost.mock.calls.map(([post]) => post.podId)).toEqual([String(team._id)]);
  });

  const expectMcpClose = async () => {
    const first = await scan({ now: NOW });
    expect(first.nudged).toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
    expect(await StalledConnectEpisode.countDocuments({ status: 'open' })).toBe(1);

    const second = await scan({ now: NOW });
    expect(second.resolved).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const { content, metadata } = mockPost.mock.calls[0][0];
    expect(metadata.kind).toBe('stalled-connect-resolved');
    expect(content).toContain('connected from your MCP client');
    expect(content).toContain('that takes the listener');

    await scan({ now: NOW });
    expect(mockPost).toHaveBeenCalledTimes(1);
  };

  it('a stamp on the installation token, read through the scan', async () => {
    await seat('mcp-install', [{ tokenHash: 'a', createdAt: ISSUED }]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'a' },
      { $set: usageStamp('runtimeTokens.$', mcpClient) },
    );

    await expectMcpClose();
  });

  it('a stamp on the bot row token, read through the scan', async () => {
    await seat('mcp-user', []);
    await botRow('mcp-user', [{ tokenHash: 'b', createdAt: ISSUED }]);
    await User.updateOne(
      { 'agentRuntimeTokens.tokenHash': 'b' },
      { $set: usageStamp('agentRuntimeTokens.$', mcpClient) },
    );

    await expectMcpClose();
  });

  it('a close that fails to post is tried again on the next pass', async () => {
    await seat('retry-close', [{ tokenHash: 'r', createdAt: ISSUED }]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'r' },
      { $set: usageStamp('runtimeTokens.$', mcpClient) },
    );
    await scan({ now: NOW });
    mockPost.mockRejectedValueOnce(new Error('store down'));

    const failed = await scan({ now: NOW });
    expect(failed.resolved).toEqual([]);
    expect(await StalledConnectEpisode.countDocuments({ status: 'open' })).toBe(1);

    const retried = await scan({ now: NOW });
    expect(retried.resolved).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('another client using the token still gets the nudge', async () => {
    await seat('not-mcp', [{ tokenHash: 'c', createdAt: ISSUED }]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'c' },
      { $set: usageStamp('runtimeTokens.$', otherClient) },
    );

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('an MCP call on a superseded token does not stop the new token\'s nudge', async () => {
    const older = new Date(ISSUED.getTime() - 60 * MINUTE);
    await seat('reissued', [
      { tokenHash: 'old', createdAt: older },
      { tokenHash: 'new', createdAt: ISSUED },
    ]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'old' },
      { $set: usageStamp('runtimeTokens.$', mcpClient) },
    );

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
  });
});
