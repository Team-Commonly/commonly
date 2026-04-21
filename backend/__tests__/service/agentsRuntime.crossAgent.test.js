/**
 * ADR-003 Phase 4 — cross-agent HTTP integration tests.
 *
 * Exercises:
 *   GET  /api/agents/runtime/memory/shared/:agentName/:instanceId?
 *   POST /api/agents/runtime/pods/:podId/ask
 *   POST /api/agents/runtime/asks/:requestId/respond
 *
 * Two installed agents (alice, bob) in one pod. Each has its own runtime
 * token (issued through the registry routes the same way real drivers do)
 * so the agentRuntimeAuth middleware runs end-to-end.
 *
 * Mocks AgentEventService.enqueue so the full event-delivery pipeline
 * (typing service, websocket, native runtime) doesn't need to be wired.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentMemory = require('../../models/AgentMemory');
const AgentAsk = require('../../models/AgentAsk');

// Stub the event service before requiring routes.
jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));
const AgentEventService = require('../../services/agentEventService');

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-for-cross-agent';

jest.setTimeout(60_000);

describe('Cross-agent HTTP routes (ADR-003 Phase 4)', () => {
  let app;
  let adminUser;
  let adminToken;
  let pod;
  let aliceToken;
  let bobToken;

  const installAndIssueToken = async (agentName, scopes = ['context:read']) => {
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agentName, podId: pod._id.toString(), scopes });
    const tokenRes = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: `${agentName} test token` });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token).toMatch(/^cm_agent_/);
    return tokenRes.body.token;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    adminUser = await User.create({
      username: 'cross-agent-admin',
      email: 'cross-agent-admin@test.com',
      password: 'password123',
    });
    adminToken = jwt.sign({ id: adminUser._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Cross Agent Pod',
      type: 'chat',
      createdBy: adminUser._id,
      members: [adminUser._id],
    });

    await AgentRegistry.create({
      agentName: 'alice',
      displayName: 'Alice',
      description: 'Test agent A',
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
    await AgentRegistry.create({
      agentName: 'bob',
      displayName: 'Bob',
      description: 'Test agent B',
      registry: 'commonly-official',
      verified: true,
      manifest: {
        name: 'bob',
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

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await AgentMemory.deleteMany({});
    await AgentAsk.deleteMany({});
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
    AgentEventService.enqueue.mockClear();

    aliceToken = await installAndIssueToken('alice');
    bobToken = await installAndIssueToken('bob');
  });

  // ----------------------------------------------------------------------- //
  // GET /memory/shared                                                      //
  // ----------------------------------------------------------------------- //

  describe('GET /memory/shared/:agentName/:instanceId?', () => {
    it('returns 401 without an agent token', async () => {
      const res = await request(app).get('/api/agents/runtime/memory/shared/bob');
      expect(res.status).toBe(401);
    });

    it('returns 404 when the target has no AgentMemory row', async () => {
      const res = await request(app)
        .get('/api/agents/runtime/memory/shared/bob')
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 400 for an empty agentName', async () => {
      // Express collapses /memory/shared/ to /memory/shared — and the route
      // pattern requires at least :agentName, so an entirely missing param
      // returns 404 (Express). A whitespace-only param exercises our 400.
      const res = await request(app)
        .get('/api/agents/runtime/memory/shared/%20')
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(400);
    });

    it('returns only public + pod-shared sections when pods overlap', async () => {
      // Bob writes a mix of visibility levels via PUT /memory.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({
          sections: {
            soul: { content: 'private soul', visibility: 'private' },
            long_term: { content: 'private long_term', visibility: 'private' },
            shared: { content: 'public bio', visibility: 'public' },
            runtime_meta: { content: 'pod-shared meta', visibility: 'pod' },
          },
        })
        .expect(200);

      // Alice (in the same pod) reads bob's shared view.
      const res = await request(app)
        .get('/api/agents/runtime/memory/shared/bob')
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.agentName).toBe('bob');
      expect(res.body.instanceId).toBe('default');
      expect(res.body.sections.soul).toBeUndefined();
      expect(res.body.sections.long_term).toBeUndefined();
      expect(res.body.sections.shared.content).toBe('public bio');
      expect(res.body.sections.runtime_meta.content).toBe('pod-shared meta');
      // sharedPods reflects which pods grounded the access
      expect(res.body.sharedPods).toEqual(expect.arrayContaining([pod._id.toString()]));
    });

    it('NEVER returns private sections, even via the shared route', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({
          sections: {
            long_term: { content: 'super secret', visibility: 'private' },
          },
        })
        .expect(200);
      const res = await request(app)
        .get('/api/agents/runtime/memory/shared/bob')
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.sections.long_term).toBeUndefined();
    });

    it('strips pod sections when requester does NOT share a pod with target', async () => {
      // Move bob to a different pod so alice and bob no longer overlap.
      const lonelyPod = await Pod.create({
        name: 'Lonely', type: 'chat', createdBy: adminUser._id, members: [adminUser._id],
      });
      await AgentInstallation.deleteMany({ agentName: 'bob' });
      await AgentInstallation.create({
        agentName: 'bob',
        podId: lonelyPod._id,
        instanceId: 'default',
        version: '1.0.0',
        installedBy: adminUser._id,
        status: 'active',
      });
      // Bob writes pod-visible content.
      await AgentMemory.create({
        agentName: 'bob',
        instanceId: 'default',
        sections: { shared: { content: 'pod only', visibility: 'pod' } },
      });
      const res = await request(app)
        .get('/api/agents/runtime/memory/shared/bob')
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.sections.shared).toBeUndefined();
      expect(res.body.sharedPods).toEqual([]);
    });

    it('still returns public sections even when there is no pod overlap', async () => {
      const lonelyPod = await Pod.create({
        name: 'Lonely2', type: 'chat', createdBy: adminUser._id, members: [adminUser._id],
      });
      await AgentInstallation.deleteMany({ agentName: 'bob' });
      await AgentInstallation.create({
        agentName: 'bob',
        podId: lonelyPod._id,
        instanceId: 'default',
        version: '1.0.0',
        installedBy: adminUser._id,
        status: 'active',
      });
      await AgentMemory.create({
        agentName: 'bob',
        instanceId: 'default',
        sections: {
          shared: { content: 'public always', visibility: 'public' },
          long_term: { content: 'pod-only', visibility: 'pod' },
        },
      });
      const res = await request(app)
        .get('/api/agents/runtime/memory/shared/bob')
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.sections.shared.content).toBe('public always');
      expect(res.body.sections.long_term).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------------- //
  // POST /pods/:podId/ask + /asks/:requestId/respond                        //
  // ----------------------------------------------------------------------- //

  describe('POST /pods/:podId/ask', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .send({ targetAgent: 'bob', question: 'q' });
      expect(res.status).toBe(401);
    });

    it('happy path — creates AgentAsk, enqueues agent.ask, returns requestId', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'bob', question: 'when is demo?' });
      expect(res.status).toBe(200);
      expect(res.body.requestId).toMatch(/[a-f0-9-]{36}/i);

      const ask = await AgentAsk.findOne({ requestId: res.body.requestId });
      expect(ask.fromAgent).toBe('alice');
      expect(ask.targetAgent).toBe('bob');
      expect(ask.question).toBe('when is demo?');

      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      const evt = AgentEventService.enqueue.mock.calls[0][0];
      expect(evt.type).toBe('agent.ask');
      expect(evt.agentName).toBe('bob');
    });

    it('rejects self-ask (alice → alice) with 400', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'alice', question: 'self' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('self_ask');
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });

    it('rejects when target is not in the pod (404)', async () => {
      // Uninstall bob from the test pod.
      await AgentInstallation.deleteMany({ agentName: 'bob' });
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'bob', question: 'q' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('target_not_in_pod');
    });

    it('rejects asking on behalf of a pod the agent is not in (403)', async () => {
      const otherPod = await Pod.create({
        name: 'Other', type: 'chat', createdBy: adminUser._id, members: [adminUser._id],
      });
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${otherPod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'bob', question: 'q' });
      expect(res.status).toBe(403);
    });

    it('rejects missing question / targetAgent with 400', async () => {
      const r1 = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'bob' });
      expect(r1.status).toBe(400);
      const r2 = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ question: 'q' });
      expect(r2.status).toBe(400);
    });

    it('returns 429 once rate limit is exceeded', async () => {
      // Pre-seed 30 recent asks from alice in this pod.
      const seed = [];
      for (let i = 0; i < 30; i += 1) {
        seed.push({
          requestId: `seed-${i}`,
          podId: pod._id,
          fromAgent: 'alice',
          fromInstanceId: 'default',
          targetAgent: 'bob',
          targetInstanceId: 'default',
          question: 'q',
          status: 'open',
          expiresAt: new Date(Date.now() + 60_000),
        });
      }
      await AgentAsk.insertMany(seed);
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'bob', question: 'one too many' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    });
  });

  describe('POST /asks/:requestId/respond', () => {
    let openRequestId;

    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetAgent: 'bob', question: 'hi' });
      openRequestId = res.body.requestId;
      AgentEventService.enqueue.mockClear();
    });

    it('happy path — bob responds, marks ask responded, enqueues response event', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/asks/${openRequestId}/respond`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ content: '2pm pacific' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const ask = await AgentAsk.findOne({ requestId: openRequestId });
      expect(ask.status).toBe('responded');
      expect(ask.response).toBe('2pm pacific');

      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      const evt = AgentEventService.enqueue.mock.calls[0][0];
      expect(evt.type).toBe('agent.ask.response');
      expect(evt.agentName).toBe('alice');
    });

    it('rejects respond by alice (not the target) with 403', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/asks/${openRequestId}/respond`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'hijack' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_target');
    });

    it('rejects unknown requestId with 404', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/asks/not-a-real-id/respond')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ content: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ask_not_found');
    });

    it('rejects empty content with 400', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/asks/${openRequestId}/respond`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ content: '' });
      expect(res.status).toBe(400);
    });

    it('rejects responding twice with 409', async () => {
      await request(app)
        .post(`/api/agents/runtime/asks/${openRequestId}/respond`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ content: 'first' })
        .expect(200);
      const res = await request(app)
        .post(`/api/agents/runtime/asks/${openRequestId}/respond`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ content: 'second' });
      expect(res.status).toBe(409);
    });
  });

  // The standard runtime-tokens HTTP route writes the token to BOTH
  // User.agentRuntimeTokens (primary lookup) and AgentInstallation.runtimeTokens
  // (back-compat fallback). The middleware always matches the User row first,
  // so the installation-token fallback path is never exercised by the routes
  // above. This block mints a token EXCLUSIVELY on the installation, leaving
  // User.agentRuntimeTokens empty, so the second branch of the middleware
  // (`AgentInstallation.findOne({ 'runtimeTokens.tokenHash': ... })`) runs.
  describe('installation-scoped token auth path (agentRuntimeAuth fallback branch)', () => {
    const crypto = require('crypto');
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    let installToken;
    let installAgentName;

    beforeEach(async () => {
      installAgentName = 'alice'; // alice is already published in beforeAll
      // alice was installed via installAndIssueToken in the parent beforeEach
      // — that wrote to BOTH locations. To force the installation-only path,
      // strip the User row's tokens here, leaving only the installation copy.
      const aliceUser = await User.findOne({
        isBot: true,
        'botMetadata.agentName': installAgentName,
      });
      if (aliceUser) {
        aliceUser.agentRuntimeTokens = [];
        await aliceUser.save();
      }
      // Mint a fresh token directly into the installation, so the hash is one
      // we know and can present.
      const installation = await AgentInstallation.findOne({
        agentName: installAgentName,
        podId: pod._id,
      });
      const raw = `cm_agent_${crypto.randomBytes(16).toString('hex')}`;
      installation.runtimeTokens = [{
        tokenHash: hash(raw),
        label: 'install-only test',
        createdAt: new Date(),
      }];
      await installation.save();
      installToken = raw;
    });

    it('POST /pods/:podId/ask works on the installation-token path', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${installToken}`)
        .send({ targetAgent: 'bob', question: 'install-token ask' });
      expect(res.status).toBe(200);
      expect(res.body.requestId).toBeTruthy();
      expect(AgentEventService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agent.ask', agentName: 'bob' }),
      );
    });

    it('POST /asks/:requestId/respond works on the installation-token path', async () => {
      const askRes = await request(app)
        .post(`/api/agents/runtime/pods/${pod._id}/ask`)
        .set('Authorization', `Bearer ${installToken}`)
        .send({ targetAgent: 'bob', question: 'q' })
        .expect(200);
      // Bob still has a normal token from parent beforeEach, so we can use it
      // to respond — verifies a mixed-auth-path interaction works end-to-end.
      const res = await request(app)
        .post(`/api/agents/runtime/asks/${askRes.body.requestId}/respond`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ content: 'install-token respond ok' });
      expect(res.status).toBe(200);
    });
  });
});
