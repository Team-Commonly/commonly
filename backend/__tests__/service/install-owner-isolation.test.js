/**
 * #609 cross-owner identity guard — regression lock.
 *
 * Self-serve BYO agents key identity + memory on (agentName, instanceId) with
 * no owner dimension, so two DIFFERENT users self-serving a custom agent under
 * the same name would share ONE bot User row + memory (a fresh account could
 * read a stranger's agent memory — reproduced live). See issue #609.
 *
 * The guard (routes/registry/install.ts) refuses to bind a self-serve
 * (ephemeral) custom agent name another user already owns. Structure mirrors
 * the proven self-serve-install.test.js.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-owner-isolation';

jest.setTimeout(60000);

describe('#609 cross-owner agent identity guard', () => {
  let app;
  let userA;
  let userB;
  let tokenA;
  let tokenB;
  let podA;
  let podA2;
  let podB;

  const installAs = (token, podId, agentName) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${token}`)
    .send({
      agentName,
      podId: podId.toString(),
      displayName: agentName,
      version: '1.0.0',
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: ['context:read', 'messages:write'],
    });

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    userA = await User.create({ username: 'iso-a', email: 'iso-a@test.com', password: 'password123' });
    userB = await User.create({ username: 'iso-b', email: 'iso-b@test.com', password: 'password123' });
    tokenA = jwt.sign({ id: userA._id.toString() }, JWT_SECRET);
    tokenB = jwt.sign({ id: userB._id.toString() }, JWT_SECRET);

    podA = await Pod.create({ name: 'A pod', type: 'chat', createdBy: userA._id, members: [userA._id] });
    podA2 = await Pod.create({ name: 'A pod 2', type: 'chat', createdBy: userA._id, members: [userA._id] });
    podB = await Pod.create({ name: 'B pod', type: 'chat', createdBy: userB._id, members: [userB._id] });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await AgentRegistry.deleteMany({ ephemeral: true });
  });

  it('refuses a second user claiming a custom name the first already owns', async () => {
    const resA = await installAs(tokenA, podA, 'assistant');
    expect(resA.status).toBe(200);

    const resB = await installAs(tokenB, podB, 'assistant');
    expect(resB.status).toBe(409);
    expect(resB.body.code).toBe('agent_name_taken');

    const bInstall = await AgentInstallation.findOne({ agentName: 'assistant', podId: podB._id });
    expect(bInstall).toBeNull();
  });

  it('lets the SAME user reinstall their own agent into another pod', async () => {
    const res1 = await installAs(tokenA, podA, 'helper');
    const res2 = await installAs(tokenA, podA2, 'helper');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
