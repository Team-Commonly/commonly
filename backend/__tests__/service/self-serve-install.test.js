/**
 * ADR-006 Phase 1 — self-serve webhook install integration test.
 *
 * Walks the full self-serve flow:
 *   authed pod-member POSTs /install with runtimeType:'webhook' and NO
 *   pre-published manifest → backend synthesizes ephemeral AgentRegistry row
 *   → mints runtime token → token authorizes /events + posting messages
 *   → ephemeral row is excluded from marketplace catalog browse
 *   → non-webhook installs without manifest still 404.
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

const JWT_SECRET = 'test-jwt-secret-self-serve-install';

jest.setTimeout(60000);

describe('ADR-006 self-serve webhook install', () => {
  let app;
  let podMember;
  let outsider;
  let memberToken;
  let outsiderToken;
  let pod;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    podMember = await User.create({
      username: 'pod-member',
      email: 'pod-member@test.com',
      password: 'password123',
    });
    outsider = await User.create({
      username: 'outsider',
      email: 'outsider@test.com',
      password: 'password123',
    });
    memberToken = jwt.sign({ id: podMember._id.toString() }, JWT_SECRET);
    outsiderToken = jwt.sign({ id: outsider._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Self-Serve Test Pod',
      type: 'chat',
      createdBy: podMember._id,
      members: [podMember._id],
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    // Wipe both ephemeral self-serve rows AND any non-ephemeral fixtures
    // created by individual tests, so order/parallelism doesn't leak.
    await AgentRegistry.deleteMany({ agentName: { $regex: /^(public-|my-|outsider-|fallback-|collide|bad-|research-)/ } });
    await AgentRegistry.deleteMany({ ephemeral: true });
  });

  it('installs a webhook agent with no published manifest and returns a runtime token', async () => {
    const installRes = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'my-research-bot',
        podId: pod._id.toString(),
        displayName: 'My Research Bot',
        version: '1.0.0',
        config: {
          runtime: {
            runtimeType: 'webhook',
          },
        },
        scopes: ['context:read', 'messages:write'],
      });

    expect(installRes.status).toBe(200);
    expect(installRes.body.success).toBe(true);
    expect(installRes.body.installation.agentName).toBe('my-research-bot');

    // Synthesized registry row marked ephemeral, owned by installer.
    const reg = await AgentRegistry.findOne({ agentName: 'my-research-bot' });
    expect(reg).toBeTruthy();
    expect(reg.ephemeral).toBe(true);
    expect(reg.publisher.userId.toString()).toBe(podMember._id.toString());
    expect(reg.registry).toBe('private');

    // Mint runtime token + verify it can poll events.
    const tokenRes = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/my-research-bot/runtime-tokens`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ label: 'self-serve-test' });
    const runtimeToken = tokenRes.body.token;
    expect(runtimeToken).toMatch(/^cm_agent_/);

    const eventsRes = await request(app)
      .get('/api/agents/runtime/events')
      .set('Authorization', `Bearer ${runtimeToken}`);
    expect(eventsRes.status).toBe(200);
    expect(Array.isArray(eventsRes.body.events)).toBe(true);
  });

  it('non-webhook installs without published manifest still 404', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'unknown-native-agent',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'native' } },
        scopes: ['context:read'],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found in registry/i);
  });

  it('rejects malformed agentName with 400 (not 500 from schema validation)', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'has spaces',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid agentName/);
    // No row should have been created on validation failure.
    const reg = await AgentRegistry.findOne({ agentName: 'has spaces' });
    expect(reg).toBeNull();
  });

  it('rejects self-serve install when caller is not a pod member', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({
        agentName: 'outsider-bot',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });
    expect(res.status).toBe(403);
    // No ephemeral row should have been created.
    const reg = await AgentRegistry.findOne({ agentName: 'outsider-bot' });
    expect(reg).toBeNull();
  });

  it('marketplace catalog excludes ephemeral self-serve agents', async () => {
    // Create one published agent and one ephemeral via self-serve.
    await AgentRegistry.create({
      agentName: 'public-marketplace-bot',
      displayName: 'Public Bot',
      description: 'Catalog-visible',
      registry: 'commonly-community',
      manifest: {
        name: 'public-marketplace-bot',
        version: '1.0.0',
        capabilities: [],
        context: { required: [] },
        runtime: { type: 'standalone', connection: 'rest' },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
    });
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'my-private-webhook',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });

    const catalogRes = await request(app)
      .get('/api/registry/agents')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(catalogRes.status).toBe(200);
    const names = (catalogRes.body.agents || []).map((a) => a.name);
    expect(names).toContain('public-marketplace-bot');
    expect(names).not.toContain('my-private-webhook');
  });
});
