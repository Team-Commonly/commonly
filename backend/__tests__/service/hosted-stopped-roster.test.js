const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const hosted = require('../../routes/hosted');
const podAgents = require('../../routes/registry/pod-agents');

const SECRET = 'hosted-stopped-roster-test';

describe('a hosted agent stopped through the route', () => {
  let app; let owner; let pod; let auth;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.HOSTED_ENGINE = 'native';
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_API_KEY = 'test-key';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/hosted', hosted.default || hosted);
    app.use('/api/registry', podAgents.default || podAgents);
    owner = await User.create({ username: 'stop-owner', email: 'stop-owner@test.com', password: 'password1' });
    pod = await Pod.create({ name: 'Stop pod', type: 'chat', createdBy: owner._id, members: [owner._id] });
    auth = { Authorization: `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}` };
    await AgentInstallation.create({
      agentName: 'stop-agent', instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id,
      config: new Map([['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'native', provisionedAt: new Date() }]]),
    });
  });

  afterAll(async () => {
    delete process.env.HOSTED_ENGINE;
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    await closeMongoDb();
  });

  const rosterConnection = async () => {
    const res = await request(app).get(`/api/registry/pods/${pod._id}/agents`).set(auth);
    expect(res.status).toBe(200);
    return res.body.agents.find((row) => row.name === 'stop-agent').connection;
  };

  it('reads as stopped on the roster, because the stop writes what the roster reads', async () => {
    expect(await rosterConnection()).toEqual({ state: 'available', lastSeenAt: null });
    const stopped = await request(app).post('/api/hosted/deprovision').set(auth)
      .send({ agentName: 'stop-agent', instanceId: 'default' });
    expect(stopped.status).toBe(200);
    expect(await rosterConnection()).toEqual({ state: 'stopped', lastSeenAt: null });
  });
});
