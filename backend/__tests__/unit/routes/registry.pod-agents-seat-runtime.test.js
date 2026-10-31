// TASK-569: both pod-agent read routes must hand the seat's newest identity to
// the payload. The helper suite (registry.seat-runtime-identity.test.js) proves
// the resolver; this one fails if either route stops passing it through.
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const mockViewer = '6a0000000000000000000001';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = mockViewer;
  req.user = { id: mockViewer };
  next();
});
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn().mockResolvedValue(true) }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const podAgentsRouter = require('../../../routes/registry/pod-agents');

const app = express();
app.use(express.json());
app.use('/api/registry', podAgentsRouter);

const viewer = new mongoose.Types.ObjectId(mockViewer);
const podA = new mongoose.Types.ObjectId();
const podB = new mongoose.Types.ObjectId();

const install = (podId, runtime, at) => AgentInstallation.create({
  agentName: 'sprint-review',
  instanceId: 'default',
  podId,
  version: '1.0.0',
  installedBy: viewer,
  status: 'active',
  config: runtime ? { runtime } : {},
}).then(async (doc) => {
  if (at) await AgentInstallation.collection.updateOne({ _id: doc._id }, { $set: { runtimeIdentityAt: new Date(at) } });
  return doc;
});

const IDENTITY = {
  runtimeType: 'webhook', host: 'byo', adapter: 'claude', wrappedCli: 'claude',
};
// sanitizeRuntimeConfig does not echo wrappedCli on this shape; the other three
// keys reach the payload, and none of pod A's stale codex group survives.
const expectNewest = (runtime) => {
  expect(runtime).toMatchObject({ runtimeType: 'webhook', host: 'byo', adapter: 'claude' });
  expect(JSON.stringify(runtime)).not.toContain('codex');
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Pod.collection.insertMany([podA, podB].map((_id) => ({
    _id, name: 'p', type: 'chat', createdBy: viewer, members: [viewer],
  })));
  // Older identity in pod A, newer one in pod B: pod A must read pod B's.
  await install(podA, {
    runtimeType: 'codex', host: 'cloud', adapter: 'codex', wrappedCli: 'codex',
  }, '2026-10-20T00:00:00Z');
  await install(podB, IDENTITY, '2026-10-25T00:00:00Z');
});
afterEach(clearMongoDb);

describe('pod-agent routes read the seat\'s newest runtime identity', () => {
  it('GET /pods/:podId/agents', async () => {
    const res = await request(app).get(`/api/registry/pods/${podA}/agents`);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a) => a.name === 'sprint-review' || a.agentName === 'sprint-review');
    expectNewest(agent.runtime);
  });

  it('GET /pods/:podId/agents/:name', async () => {
    const res = await request(app).get(`/api/registry/pods/${podA}/agents/sprint-review`);
    expect(res.status).toBe(200);
    expectNewest(res.body.agent.runtime);
  });
});
