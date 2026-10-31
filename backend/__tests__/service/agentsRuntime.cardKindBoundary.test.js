/**
 * TASK-657 — the agent write path accepts only payload kind "ui".
 *
 * CTO's ruling on #2892: connector results carry server-written payloads
 * rendered by fixed cards, and agent-authored OpenUI stays on kind "ui". The
 * two lanes stay apart only because the agent write path refuses every other
 * kind, so a connector card cannot be forged by an agent.
 *
 * Real Mongo / Postgres (tier 1). Every case goes through the runtime route
 * `POST /api/agents/runtime/pods/:podId/messages`, which is the path the MCP
 * `commonly_post_message` tool posts through. A refused post is checked against
 * the store, not the response code: the pod's message list must not grow.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const catalogueRevision = require('../../config/uiCardCatalogueRevision.json');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-for-card-kind-boundary';

jest.setTimeout(60_000);

// Kinds a stranger could try to forge. `approval` is written by the kernel
// today; `connector` is the kind CTO's ruling reserves for connector results;
// the rest are unknown, a case variant, and a missing kind.
const REFUSED_KINDS = ['approval', 'connector', 'system', 'UI', 'ui-connector', undefined];

describe('agent write path accepts only payload kind "ui" (TASK-657)', () => {
  let app;
  let humanUser;
  let humanToken;
  let pod;
  let aliceToken;

  const installAndIssueToken = async (agentName) => {
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${humanToken}`)
      .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
    const res = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
      .set('Authorization', `Bearer ${humanToken}`)
      .send({ label: `${agentName} card-kind token` });
    expect(res.status).toBe(200);
    return res.body.token;
  };

  const uiPayload = (overrides = {}) => ({
    ...catalogueRevision,
    kind: 'ui',
    v: 1,
    lang: 'openui@1',
    source: 'root = Text("hello")',
    ...overrides,
  });

  // The store, not the response: count the pod's messages through the same
  // runtime read every agent uses. An empty or stale read would hide a write,
  // so this asks for the newest 50 and counts every row.
  const storedMessageCount = async () => {
    const res = await request(app)
      .get(`/api/agents/runtime/pods/${pod._id}/messages?limit=50`)
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body) ? res.body : res.body.messages;
    return rows.length;
  };

  const postCard = (payload, content = 'fallback') => request(app)
    .post(`/api/agents/runtime/pods/${pod._id}/messages`)
    .set('Authorization', `Bearer ${aliceToken}`)
    .send({ content, messageType: 'card', payload, continueAnyway: true });

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    humanUser = await User.create({
      username: 'card-kind-human',
      email: 'card-kind-human@test.com',
      password: 'password123',
    });
    humanToken = jwt.sign({ id: humanUser._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Card Kind Boundary Pod',
      type: 'chat',
      createdBy: humanUser._id,
      members: [humanUser._id],
    });

    await AgentRegistry.create({
      agentName: 'alice',
      displayName: 'Alice',
      description: 'Card kind boundary agent',
      registry: 'commonly-official',
      verified: true,
      manifest: {
        name: 'alice',
        version: '1.0.0',
        capabilities: [{ name: 'memory', description: 'memory' }],
        context: { required: ['context:read'] },
        runtime: { type: 'standalone', connection: 'rest' },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  // A fresh pod per test. The runtime refuses a fourth consecutive agent post
  // in a pod with nobody else speaking (consecutive_run_cap), and that refusal
  // comes back as a 200, so one shared pod would fail the accept case for the
  // wrong reason.
  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
    pod = await Pod.create({
      name: 'Card Kind Boundary Pod',
      type: 'chat',
      createdBy: humanUser._id,
      members: [humanUser._id],
    });
    aliceToken = await installAndIssueToken('alice');
  });

  it.each(REFUSED_KINDS)('refuses a card of payload kind %s and stores nothing', async (kind) => {
    const before = await storedMessageCount();
    const res = await postCard(uiPayload({ kind }));

    expect(res.status).toBe(400);
    expect(await storedMessageCount()).toBe(before);
  });

  it('refuses a non-ui kind even when its envelope is otherwise valid', async () => {
    const before = await storedMessageCount();
    const res = await postCard({ ...uiPayload(), kind: 'connector', source: 'root = Text("forged")' });

    expect(res.status).toBe(400);
    expect(await storedMessageCount()).toBe(before);
  });

  it('still accepts a valid kind "ui" card, so the refusals cannot pass by refusing everything', async () => {
    const before = await storedMessageCount();
    const res = await postCard(uiPayload());

    expect(res.status).toBe(200);
    expect(res.body.refused).toBeUndefined();
    expect(await storedMessageCount()).toBe(before + 1);
  });
});
