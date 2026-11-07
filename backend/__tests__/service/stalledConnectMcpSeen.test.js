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
const { usageStamp } = require('../../middleware/agentRuntimeAuth');
const { scan } = require('../../services/stalledConnectService');

const MINUTE = 60 * 1000;
const NOW = new Date('2026-11-07T12:00:00Z');
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

describe('a seat that an MCP client has used is not nudged as never connected', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    mockPost.mockReset();
    mockPost.mockResolvedValue({ success: true, message: { id: 'm1' } });
  });

  it('a stamp on the installation token, read through the scan', async () => {
    await seat('mcp-install', [{ tokenHash: 'a', createdAt: ISSUED }]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'a' },
      { $set: usageStamp('runtimeTokens.$', mcpClient) },
    );

    const r = await scan({ now: NOW });

    expect(r.nudged).toEqual([]);
    expect(r.skippedNotStalled).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
    expect(await StalledConnectEpisode.countDocuments({})).toBe(0);
  });

  it('a stamp on the bot row token, read through the scan', async () => {
    await seat('mcp-user', []);
    await botRow('mcp-user', [{ tokenHash: 'b', createdAt: ISSUED }]);
    await User.updateOne(
      { 'agentRuntimeTokens.tokenHash': 'b' },
      { $set: usageStamp('agentRuntimeTokens.$', mcpClient) },
    );

    const r = await scan({ now: NOW });

    expect(r.nudged).toEqual([]);
    expect(r.skippedNotStalled).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
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
      { tokenHash: 'old', createdAt: older, lastMcpSeenAt: new Date(older.getTime() + MINUTE) },
      { tokenHash: 'new', createdAt: ISSUED },
    ]);

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
  });
});
