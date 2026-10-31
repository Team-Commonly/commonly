// TASK-704: a daemon-bound seat whose declared runtimeType is stale (codex) but
// whose poll reports claude must project claude as its adapter, so the chip
// does not name the stale harness. An explicit adapter still wins.
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const mockViewer = '6a0000000000000000000002';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = mockViewer;
  req.user = { id: mockViewer };
  next();
});
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn().mockResolvedValue(true) }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');
const podAgentsRouter = require('../../../routes/registry/pod-agents');

const app = express();
app.use(express.json());
app.use('/api/registry', podAgentsRouter);

const viewer = new mongoose.Types.ObjectId(mockViewer);
const podId = new mongoose.Types.ObjectId();
const username = AgentIdentityService.buildAgentUsername('polish', 'default');

const installWith = (runtime) => AgentInstallation.create({
  agentName: 'polish',
  instanceId: 'default',
  podId,
  version: '1.0.0',
  installedBy: viewer,
  status: 'active',
  config: { runtime },
});

const chipAdapterFor = async (runtime) => {
  await installWith(runtime);
  const res = await request(app).get(`/api/registry/pods/${podId}/agents`);
  expect(res.status).toBe(200);
  const agent = res.body.agents.find((a) => a.agentName === 'polish' || a.name === 'polish');
  return agent.runtime;
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Pod.collection.insertOne({
    _id: podId, name: 'p', type: 'chat', createdBy: viewer, members: [viewer],
  });
  // A daemon-bound bot user: the projection treats it as a wrapper seat.
  await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@agents.commonly.invalid`, botMetadata: { machineId: 'machine-1', agentName: 'polish', instanceId: 'default' },
  });
});
afterEach(async () => {
  await clearMongoDb();
  await mongoose.connection.collection('users').deleteMany({});
});

describe('daemon-bound seat chip (TASK-704)', () => {
  it('projects the poller report over a stale codex runtimeType', async () => {
    const runtime = await chipAdapterFor({ runtimeType: 'codex', host: 'byo', reportedCli: 'claude' });
    expect(runtime).toMatchObject({ runtimeType: 'wrapper', adapter: 'claude' });
  });

  it('an explicit adapter still outranks the report', async () => {
    const runtime = await chipAdapterFor({
      runtimeType: 'codex', host: 'byo', adapter: 'pi', reportedCli: 'claude',
    });
    expect(runtime).toMatchObject({ adapter: 'pi' });
  });

  it('with no report, the declared runtimeType still labels the seat', async () => {
    const runtime = await chipAdapterFor({ runtimeType: 'codex', host: 'byo' });
    expect(runtime).toMatchObject({ adapter: 'codex' });
  });
});
