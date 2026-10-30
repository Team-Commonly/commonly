/**
 * commonly_agent_status is how Scout answers "is my agent running?". On
 * 2026-10-28 it missed a listener that was polling: the seat was installed in
 * another pod, and its key lived in the credential ledger, not on the bot User
 * (D172). Real Mongo, so the stores are the ones runtime auth writes.
 */
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../services/agentComputerBroker', () => ({
  agentComputerBroker: {},
  agentComputerEnabled: false,
}));

const mongoose = require('mongoose');
const User = require('../../models/User');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { dispatchTool } = require('../../services/nativeRuntimeService');

jest.setTimeout(60000);

describe('commonly_agent_status', () => {
  const scoutPod = new mongoose.Types.ObjectId();
  const otherPod = new mongoose.Types.ObjectId();
  let owner;
  let bot;

  beforeAll(async () => {
    await setupMongoDb();
    owner = await User.create({ username: 'status-owner', email: 'status-owner@test.com', password: 'password123' });
    bot = await User.create({
      username: 'claude-code-status-seat', email: 'status-seat@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'claude-code', instanceId: 'status-seat' },
    });
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: 'claude-code' });
    await AgentCredential.deleteMany({ agentUserId: bot._id });
    await AgentInstallation.create({
      agentName: 'claude-code', instanceId: 'status-seat', podId: otherPod, version: '1', installedBy: owner._id,
      config: new Map([['runtime', { runtimeType: 'wrapper' }]]),
    });
  });

  const ask = (requesterId) => dispatchTool('commonly_agent_status', {}, {
    podId: String(scoutPod), agentName: 'scout', instanceId: 'default', displayName: 'Scout',
    installationConfig: {}, runId: 'run-status', computerRequesterId: requesterId,
  });

  it('reports the asker\'s agent from another pod, live from its ledger key', async () => {
    await AgentCredential.create({
      tokenHash: 'status-ledger-hash', kind: 'runtime', ownerUserId: owner._id, agentUserId: bot._id,
      lastUsedAt: new Date(Date.now() - 5000),
    });
    const result = await ask(String(owner._id));
    expect(result.content.agents).toEqual([expect.objectContaining({
      agentName: 'claude-code', state: 'active', inThisPod: false,
    })]);
  });

  it('reads a key kept on the installation', async () => {
    await AgentInstallation.updateOne({ agentName: 'claude-code' },
      { $set: { runtimeTokens: [{ tokenHash: 'legacy-hash', lastUsedAt: new Date(Date.now() - 5000) }] } });
    const result = await ask(String(owner._id));
    expect(result.content.agents[0].state).toBe('active');
  });

  it('keeps this pod\'s agents when the asker has more than 100 installs elsewhere', async () => {
    // Inserted before the pod's own row, so a capped $or read could cut it.
    await AgentInstallation.insertMany(Array.from({ length: 110 }, (_, n) => ({
      agentName: 'claude-code', instanceId: `elsewhere-${n}`, podId: new mongoose.Types.ObjectId(), version: '1',
      installedBy: owner._id, config: new Map([['runtime', { runtimeType: 'wrapper' }]]),
    })));
    await AgentInstallation.create({
      agentName: 'claude-code', instanceId: 'in-scout-pod', podId: scoutPod, version: '1',
      installedBy: new mongoose.Types.ObjectId(), config: new Map([['runtime', { runtimeType: 'wrapper' }]]),
    });
    const { agents } = (await ask(String(owner._id))).content;
    expect(agents[0]).toEqual(expect.objectContaining({ inThisPod: true }));
    expect(agents.filter((a) => a.inThisPod)).toHaveLength(1);
    expect(agents.filter((a) => !a.inThisPod)).toHaveLength(100);
  });

  it('reports a failed key-store read as a failed call, not as never-connected', async () => {
    const spy = jest.spyOn(AgentCredential, 'find').mockImplementation(() => { throw new Error('ledger down'); });
    try {
      const result = await ask(String(owner._id));
      expect(result.content).toEqual({ ok: false, error: 'ledger down' });
    } finally {
      spy.mockRestore();
    }
  });

  it('does not list another person\'s agents from other pods', async () => {
    const result = await ask(String(new mongoose.Types.ObjectId()));
    expect(result.content.agents).toEqual([]);
  });
});
