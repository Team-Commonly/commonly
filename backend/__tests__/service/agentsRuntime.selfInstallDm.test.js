/**
 * POST /api/agents/runtime/pods/:podId/self-install refuses a DM-type pod
 * (agent-room, agent-dm, agent-admin) before anything is written.
 *
 * The 1:1 guard lives in ensureAgentInPod, which runs after
 * AgentInstallation.install, so without this refusal an agent-created DM pod
 * that is not invite-only would get an installation row for the caller while
 * its membership was refused. Here every such pod is open, the case the
 * invite-only check above does not catch.
 *
 * Its own file: agentsRuntime.crossAgent.test.js mints two tokens per test
 * and sits at the token route's 60-a-minute limit.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-for-self-install-dm';

jest.setTimeout(60000);

const registryRow = (agentName) => ({
  agentName,
  displayName: agentName,
  description: `Test agent ${agentName}`,
  registry: 'commonly-official',
  verified: true,
  manifest: {
    name: agentName,
    version: '1.0.0',
    capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] },
    runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0',
  versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

describe('self-install into a DM-type pod', () => {
  let app;
  let alice;
  let bob;
  let bobToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    const admin = await User.create({ username: 'self-install-admin', email: 'self-install-admin@test.com', password: 'password123' });
    const adminToken = jwt.sign({ id: admin._id.toString() }, JWT_SECRET);
    const home = await Pod.create({
      name: 'Home', type: 'chat', createdBy: admin._id, members: [admin._id], 
    });
    await AgentRegistry.create(registryRow('alice'));
    await AgentRegistry.create(registryRow('bob'));

    const installAndIssueToken = async (agentName) => {
      await request(app).post('/api/registry/install').set('Authorization', `Bearer ${adminToken}`)
        .send({ agentName, podId: home._id.toString(), scopes: ['context:read'] });
      const res = await request(app).post(`/api/registry/pods/${home._id}/agents/${agentName}/runtime-tokens`)
        .set('Authorization', `Bearer ${adminToken}`).send({ label: `${agentName} test token` });
      expect(res.status).toBe(200);
      return res.body.token;
    };
    await installAndIssueToken('alice');
    bobToken = await installAndIssueToken('bob');
    alice = await User.findOne({ isBot: true, 'botMetadata.agentName': 'alice' });
    bob = await User.findOne({ isBot: true, 'botMetadata.agentName': 'bob' });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  it.each(['agent-room', 'agent-dm', 'agent-admin'])(
    'refuses an open, agent-created %s pod and writes no installation or membership',
    async (type) => {
      const dmPod = await Pod.create({
        name: `Open ${type}`, type, joinPolicy: 'open', createdBy: alice._id, members: [alice._id],
      });

      const res = await request(app)
        .post(`/api/agents/runtime/pods/${dmPod._id}/self-install`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('self_install_dm_refused');
      expect(await AgentInstallation.countDocuments({ podId: dmPod._id })).toBe(0);
      const after = await Pod.findById(dmPod._id).lean();
      expect(after.members.map(String)).not.toContain(String(bob._id));
    },
  );

  it('still self-installs into an open, agent-created team pod', async () => {
    const team = await Pod.create({
      name: 'Open team', type: 'team', joinPolicy: 'open', createdBy: alice._id, members: [alice._id],
    });
    const res = await request(app)
      .post(`/api/agents/runtime/pods/${team._id}/self-install`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(await AgentInstallation.isInstalled('bob', team._id, 'default')).toBe(true);
  });
});
