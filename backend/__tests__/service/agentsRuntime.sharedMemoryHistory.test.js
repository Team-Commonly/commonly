/**
 * GET /api/agents/runtime/memory/shared/:agentName/:instanceId? — the shared
 * view returns a section's current content only; version history stays on
 * the owner's GET /memory. Two installed agents (alice, bob) share one pod.
 *
 * Kept apart from agentsRuntime.crossAgent.test.js because that suite issues
 * fresh runtime tokens per test and sits close to the token route's limit.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry } = require('../../models/AgentRegistry');
const AgentMemory = require('../../models/AgentMemory');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-for-shared-memory-history';
const EARLIER = 'earlier-private-wording-7f3a';

jest.setTimeout(60000);

describe('GET /memory/shared — the shared view carries no version history', () => {
  let app;
  let adminToken;
  let pod;
  let aliceToken;
  let bobToken;

  const registerAgent = (agentName) => AgentRegistry.create({
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

  const installAndIssueToken = async (agentName) => {
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
    const tokenRes = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: `${agentName} test token` });
    expect(tokenRes.status).toBe(200);
    return tokenRes.body.token;
  };

  const writeThenWiden = async (visibility) => {
    await request(app)
      .put('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ sections: { long_term: { content: EARLIER, visibility: 'private' } } })
      .expect(200);
    await request(app)
      .put('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ sections: { long_term: { content: 'current wording', visibility } } })
      .expect(200);
    // Precondition: the stored record really holds the earlier version.
    const stored = await AgentMemory.findOne({ agentName: 'bob', instanceId: 'default' }).lean();
    expect(stored.sections.long_term.history[0].content).toBe(EARLIER);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    const admin = await User.create({
      username: 'shared-history-admin',
      email: 'shared-history-admin@test.com',
      password: 'password123',
    });
    adminToken = jwt.sign({ id: admin._id.toString() }, JWT_SECRET);
    pod = await Pod.create({
      name: 'Shared History Pod', type: 'chat', createdBy: admin._id, members: [admin._id],
    });
    await registerAgent('alice');
    await registerAgent('bob');
    aliceToken = await installAndIssueToken('alice');
    bobToken = await installAndIssueToken('bob');
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentMemory.deleteMany({});
  });

  it.each(['pod', 'public'])('returns a section widened to %s without its history', async (visibility) => {
    await writeThenWiden(visibility);
    const res = await request(app)
      .get('/api/agents/runtime/memory/shared/bob')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sharedPods).toEqual([pod._id.toString()]);
    expect(res.body.sections.long_term.content).toBe('current wording');
    expect(res.body.sections.long_term).not.toHaveProperty('history');
    expect(JSON.stringify(res.body)).not.toContain(EARLIER);
  });

  it('returns a section without fields the schema does not declare', async () => {
    await writeThenWiden('public');
    // Written past the schema, as an older or out-of-band writer could.
    await AgentMemory.collection.updateOne(
      { agentName: 'bob', instanceId: 'default' },
      { $set: { 'sections.long_term.draftNotes': 'undeclared-field-7f3a' } },
    );
    const res = await request(app)
      .get('/api/agents/runtime/memory/shared/bob')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sections.long_term.content).toBe('current wording');
    expect(res.body.sections.long_term).not.toHaveProperty('draftNotes');
    expect(JSON.stringify(res.body)).not.toContain('undeclared-field-7f3a');
  });

  it("keeps history on the owner's own GET /memory", async () => {
    await writeThenWiden('public');
    const res = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${bobToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sections.long_term.history[0].content).toBe(EARLIER);
  });
});
