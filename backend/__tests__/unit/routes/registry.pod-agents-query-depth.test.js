// F65 (11-02): GET /pods/:podId/agents ran its ~21 queries one after another.
// At prod's ~42ms a round trip that is 0.85s for a one-agent pod and up to
// 1.7s for a 23-agent pod before any load, and the pages that fetch it once
// per pod (Your Team, Activity, Connectors) sent ~100 at once and drew 504s
// at nginx's 5s limit (08:58Z). Queries that need only the pod's installs run
// together, so the request costs a handful of round trips, not one per query.
// The measure is waves: how many times the in-flight query count rises from
// zero. Each query is held a few ms, so queries started together overlap.
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
const User = require('../../../models/User');
const podAgentsRouter = require('../../../routes/registry/pod-agents');

const app = express();
app.use(express.json());
app.use('/api/registry', podAgentsRouter);

const viewer = new mongoose.Types.ObjectId(mockViewer);
const pod = new mongoose.Types.ObjectId();

// Count waves of in-flight Mongo work while a request runs.
const meter = {
  on: false, inFlight: 0, waves: 0, queries: 0, 
};
const hold = (proto) => {
  const { exec } = proto;
  // eslint-disable-next-line no-param-reassign
  proto.exec = async function heldExec(...args) {
    if (!meter.on) return exec.apply(this, args);
    meter.queries += 1;
    if (meter.inFlight === 0) meter.waves += 1;
    meter.inFlight += 1;
    try {
      await new Promise((resolve) => { setTimeout(resolve, 15); });
      return await exec.apply(this, args);
    } finally {
      meter.inFlight -= 1;
    }
  };
  return exec;
};
let restoreQuery;
let restoreAggregate;

beforeAll(async () => {
  await setupMongoDb();
  restoreQuery = hold(mongoose.Query.prototype);
  restoreAggregate = hold(mongoose.Aggregate.prototype);
});
afterAll(async () => {
  mongoose.Query.prototype.exec = restoreQuery;
  mongoose.Aggregate.prototype.exec = restoreAggregate;
  await closeMongoDb();
});
beforeEach(async () => {
  await Pod.collection.insertOne({
    _id: pod, name: 'p', type: 'chat', createdBy: viewer, members: [viewer],
  });
  const names = ['scout', 'sprint-review', 'linear-walk'];
  await Promise.all(names.map((name) => AgentInstallation.create({
    agentName: name, instanceId: 'default', podId: pod, version: '1.0.0', installedBy: viewer, status: 'active', config: {},
  })));
  await User.collection.insertMany(names.map((name) => ({
    username: name, email: `${name}@agents.test`, isBot: true, botMetadata: { agentName: name, instanceId: 'default' },
  })));
});
afterEach(clearMongoDb);

describe('GET /pods/:podId/agents round trips', () => {
  it('answers the full roster', async () => {
    const res = await request(app).get(`/api/registry/pods/${pod}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents.map((a) => a.name || a.agentName).sort()).toEqual(['linear-walk', 'scout', 'sprint-review']);
  });

  it('runs its queries in a few waves, not one per query', async () => {
    Object.assign(meter, {
      on: true, inFlight: 0, waves: 0, queries: 0, 
    });
    const res = await request(app).get(`/api/registry/pods/${pod}/agents`);
    meter.on = false;
    expect(res.status).toBe(200);
    // Recorded for the PR: the sequential handler measured one wave per query.
    console.log(`[pod-agents depth] ${meter.queries} queries in ${meter.waves} waves`);
    expect(meter.queries).toBeGreaterThan(10);
    expect(meter.waves).toBeLessThanOrEqual(7);
  });
});
