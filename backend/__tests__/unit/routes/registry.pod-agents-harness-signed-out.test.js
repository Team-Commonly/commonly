// F459 (d): a computer seat whose harness is installed but signed out read
// "idle · now" on the team page, because its key is in use (the daemon polls)
// while every message it gets fails. The roster now carries the computer's own
// signed-out report for that seat, to its installer only.
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const mockViewer = '6a0000000000000000000011';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = mockViewer;
  req.user = { id: mockViewer };
  next();
});
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn().mockResolvedValue(true) }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentCredential = require('../../../models/AgentCredential');
const Machine = require('../../../models/Machine');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');
const podAgentsRouter = require('../../../routes/registry/pod-agents');

const app = express();
app.use(express.json());
app.use('/api/registry', podAgentsRouter);

const viewer = new mongoose.Types.ObjectId(mockViewer);
const other = new mongoose.Types.ObjectId();
const podId = new mongoose.Types.ObjectId();
const MACHINE = 'mach-f459';

const seat = async ({ inventory, installedBy = viewer, adapter = 'claude' }) => {
  await Machine.create({ ownerUserId: installedBy, machineId: MACHINE, name: 'Studio Mac', runtimeInventory: inventory, lastSeenAt: new Date() });
  const bot = await User.create({
    username: AgentIdentityService.buildAgentUsername('nova', 'default'),
    email: 'nova-f459@agents.invalid',
    password: 'x'.repeat(16),
    isBot: true,
    botMetadata: { agentName: 'nova', instanceId: 'default', machineId: MACHINE },
  });
  await AgentCredential.create({
    tokenHash: `h-${Date.now()}-${Math.random()}`, kind: 'runtime', ownerUserId: installedBy, agentUserId: bot._id, status: 'active', lastUsedAt: new Date(),
  });
  await AgentInstallation.create({
    agentName: 'nova', instanceId: 'default', podId, version: '1.0.0', installedBy, status: 'active',
    config: { runtime: { runtimeType: 'wrapper', adapter } },
  });
};

const nova = async () => {
  const res = await request(app).get(`/api/registry/pods/${podId}/agents`);
  expect(res.status).toBe(200);
  return res.body.agents.find((a) => a.name === 'nova');
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Pod.collection.insertOne({ _id: podId, name: 'p', type: 'chat', createdBy: viewer, members: [viewer, other] });
});
afterEach(clearMongoDb);

describe('a computer seat whose harness is signed out', () => {
  it('is connected, and names the signed-out harness to its installer', async () => {
    await seat({ inventory: [{ harness: 'claude', installed: true, signedIn: false }] });
    const agent = await nova();
    expect(agent.connection.state).toBe('connected');
    expect(agent.harnessSignedOut).toBe('claude');
  });

  it('says nothing when the harness is signed in, or the computer gave no verdict', async () => {
    await seat({ inventory: [{ harness: 'claude', installed: true, signedIn: true }, { harness: 'codex', installed: true }] });
    expect((await nova()).harnessSignedOut).toBeUndefined();
    await clearMongoDb();
    await Pod.collection.insertOne({ _id: podId, name: 'p', type: 'chat', createdBy: viewer, members: [viewer, other] });
    await seat({ inventory: [{ harness: 'codex', installed: true }], adapter: 'codex' });
    expect((await nova()).harnessSignedOut).toBeUndefined();
  });

  it('reads the harness the seat runs, not another one on the computer', async () => {
    await seat({ inventory: [{ harness: 'claude', installed: true, signedIn: true }, { harness: 'codex', installed: true, signedIn: false }] });
    expect((await nova()).harnessSignedOut).toBeUndefined();
  });

  it('keeps another person\'s computer report from a viewer who did not install the seat', async () => {
    await seat({ inventory: [{ harness: 'claude', installed: true, signedIn: false }], installedBy: other });
    expect((await nova()).harnessSignedOut).toBeUndefined();
  });
});
