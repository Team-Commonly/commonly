/**
 * #529 hosted-agent entitlement gate — regression lock.
 *
 * The open-registration prerequisite: installing a CLOUD (Commonly-hosted)
 * runtime requires the installer to be an admin OR carry the `cloudAgents`
 * entitlement. BYO runtimes (host:'byo', webhook, claude-code) stay open to
 * every authenticated pod member.
 *
 * This test locks both halves of the gate so a future refactor can't silently
 * either (a) start charging compute to every new signup or (b) lock legit
 * BYO installs behind the entitlement.
 *
 * Gate lives in routes/registry/install.ts (~284) and consults
 * agentIdentityService.isCloudRuntime.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');

const registryRoutes = require('../../routes/registry');

const JWT_SECRET = 'test-jwt-secret-cloud-gate';

jest.setTimeout(60000);

describe('#529 hosted-agent entitlement gate', () => {
  let app;
  let plainUser; // non-admin, non-entitled
  let adminUser;
  let entitledUser;
  let plainToken;
  let adminToken;
  let entitledToken;
  let pod;

  const installAs = (token, body) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);

    plainUser = await User.create({
      username: 'gate-plain',
      email: 'gate-plain@test.com',
      password: 'password123',
    });
    adminUser = await User.create({
      username: 'gate-admin',
      email: 'gate-admin@test.com',
      password: 'password123',
      role: 'admin',
    });
    entitledUser = await User.create({
      username: 'gate-entitled',
      email: 'gate-entitled@test.com',
      password: 'password123',
      entitlements: { cloudAgents: true },
    });

    plainToken = jwt.sign({ id: plainUser._id.toString() }, JWT_SECRET);
    adminToken = jwt.sign({ id: adminUser._id.toString() }, JWT_SECRET);
    entitledToken = jwt.sign({ id: entitledUser._id.toString() }, JWT_SECRET);

    // All three are members so the pod-membership check passes and we exercise
    // the entitlement gate specifically (not the 403 from non-membership).
    pod = await Pod.create({
      name: 'Cloud Gate Test Pod',
      type: 'chat',
      createdBy: plainUser._id,
      members: [plainUser._id, adminUser._id, entitledUser._id],
    });

    // A published agent so getByName resolves (a non-webhook install with no
    // manifest 404s before reaching the gate). The effective runtimeType is
    // driven by the per-install config.runtime, not this manifest.
    await AgentRegistry.create({
      agentName: 'cloud-gate-bot',
      displayName: 'Cloud Gate Bot',
      description: 'Fixture agent for the entitlement-gate regression test.',
      registry: 'commonly-community',
      manifest: {
        name: 'cloud-gate-bot',
        version: '1.0.0',
        capabilities: [],
        context: { required: [] },
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
    // Clear installs/profiles between cases so each can install into the same
    // pod without tripping the "already installed" guard.
    await AgentInstallation.deleteMany({});
    await AgentProfile.deleteMany({});
  });

  it('blocks a non-admin, non-entitled user from installing a CLOUD runtime', async () => {
    const res = await installAs(plainToken, {
      agentName: 'cloud-gate-bot',
      podId: pod._id.toString(),
      config: { runtime: { runtimeType: 'internal' } },
      scopes: [],
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('cloud_agents_not_entitled');
    // Gate fires before any install row is written.
    const inst = await AgentInstallation.findOne({ agentName: 'cloud-gate-bot', podId: pod._id });
    expect(inst).toBeNull();
  });

  it('allows the same user to install a BYO (host:byo) runtime', async () => {
    const res = await installAs(plainToken, {
      agentName: 'cloud-gate-bot',
      podId: pod._id.toString(),
      config: { runtime: { runtimeType: 'codex', host: 'byo' } },
      scopes: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows a non-entitled user to self-serve install a webhook (BYO) runtime', async () => {
    const res = await installAs(plainToken, {
      agentName: 'my-webhook-bot',
      podId: pod._id.toString(),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows an admin to install a CLOUD runtime', async () => {
    const res = await installAs(adminToken, {
      agentName: 'cloud-gate-bot',
      podId: pod._id.toString(),
      config: { runtime: { runtimeType: 'internal' } },
      scopes: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows an entitled (cloudAgents) user to install a CLOUD runtime', async () => {
    const res = await installAs(entitledToken, {
      agentName: 'cloud-gate-bot',
      podId: pod._id.toString(),
      config: { runtime: { runtimeType: 'moltbot' } },
      scopes: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
