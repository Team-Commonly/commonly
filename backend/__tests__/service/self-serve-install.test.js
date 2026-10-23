/**
 * Self-serve webhook and local wrapper install integration tests.
 *
 * Walks the full self-serve flow:
 *   authed pod-member POSTs /install with runtimeType:'webhook' and NO
 *   pre-published manifest → backend synthesizes ephemeral AgentRegistry row
 *   → mints runtime token → token authorizes /events + posting messages
 *   → ephemeral row is excluded from marketplace catalog browse
 *   → local wrapper can create the same owned identity and request placement
 *   → unsupported runtimes without a manifest still 404.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const Machine = require('../../models/Machine');

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');
const agentBindingRoutes = require('../../routes/agentBinding');

const JWT_SECRET = 'test-jwt-secret-self-serve-install';

jest.setTimeout(60000);

describe('self-serve BYO install', () => {
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
    app.use('/api/agent-binding', agentBindingRoutes);

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

  it('a plain member cannot install into a publicRead pod — the 07-24 incident, closed at the server', async () => {
    // The web picker was fixed on 07-24; the CLI self-serve path was not, and
    // tablebench-agent landed in Commonly HQ on 08-21 through it. The guard
    // now lives where every client inherits it.
    const hq = await Pod.create({
      name: 'Community HQ Fixture',
      type: 'chat',
      publicRead: true,
      createdBy: outsider._id,
      members: [outsider._id, podMember._id],
    });
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'my-hq-crasher',
        podId: hq._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('public_pod_requires_admin');

    // The pod CREATOR still installs fine — community pods keep their admin.
    const creatorRes = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({
        agentName: 'outsider-hq-bot',
        podId: hq._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });
    expect(creatorRes.status).toBe(200);
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

  it('installs a new wrapper identity and accepts its machine placement request', async () => {
    const machine = await Machine.create({
      ownerUserId: podMember._id, machineId: 'self-serve-machine', name: 'My computer',
    });
    const installRes = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'my-machine-agent',
        instanceId: 'default',
        displayName: 'Recorder',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'wrapper' }, persona: 'recorder' },
        scopes: ['context:read'],
      });
    expect(installRes.status).toBe(200);
    const registryRow = await AgentRegistry.findOne({ agentName: 'my-machine-agent' }).lean();
    expect(registryRow).toMatchObject({ ephemeral: true, registry: 'private' });
    expect(String(registryRow.publisher.userId)).toBe(String(podMember._id));
    const installation = await AgentInstallation.findOne({ agentName: 'my-machine-agent' }).lean();
    expect(installation.instanceId).toBe('default');
    expect(installation.config.runtime.runtimeType).toBe('wrapper');

    const placement = await request(app)
      .post('/api/agent-binding/request')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: 'my-machine-agent', instanceId: 'default', machineId: machine.machineId });
    expect(placement.status).toBe(200);
    expect(placement.body).toMatchObject({ requested: true, machineId: machine.machineId });
    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': 'my-machine-agent' }).lean();
    expect(bot.botMetadata.requestedMachineId).toBe(machine.machineId);
  });

  it('refuses a reserved wrapper name before creating an ephemeral row', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'claude-code', podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'wrapper' } }, scopes: [],
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('agent_name_reserved');
    expect(await AgentRegistry.findOne({ agentName: 'claude-code', ephemeral: true })).toBeNull();
  });

  it('keeps a wrapper ephemeral name owned by its original installer', async () => {
    const name = 'my-wrapper-seat';
    const ownerInstall = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'wrapper' } }, scopes: [] });
    expect(ownerInstall.status).toBe(200);
    const anotherPod = await Pod.create({
      name: 'Other workspace', type: 'chat', createdBy: outsider._id, members: [outsider._id],
    });
    const refused = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ agentName: name, podId: anotherPod._id.toString(), config: { runtime: { runtimeType: 'wrapper' } }, scopes: [] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('agent_name_taken');
    expect(await AgentInstallation.countDocuments({ agentName: name, podId: anotherPod._id })).toBe(0);
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

  it('reinstall over a stale uninstalled row succeeds (no 500 from duplicate AgentProfile)', async () => {
    // First install creates both AgentInstallation and AgentProfile.
    const first = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'reinstall-target',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });
    expect(first.status).toBe(200);

    const issued = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/reinstall-target/runtime-tokens`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ label: 'old runtime' });
    expect(issued.status).toBe(200);
    const oldToken = issued.body.token;
    expect((await request(app).get('/api/agents/runtime/events')
      .set('Authorization', `Bearer ${oldToken}`)).status).toBe(200);

    // Simulate reset-demo-account.sh's raw mongo updateMany: mark
    // the AgentInstallation as uninstalled WITHOUT cascading to
    // AgentProfile (which is what causes the 500 in production). Also
    // archive the AgentProfile to ensure the upsert restores status.
    await AgentInstallation.updateOne(
      { agentName: 'reinstall-target', podId: pod._id },
      { $set: { status: 'uninstalled' } },
    );
    await AgentProfile.updateOne(
      { agentName: 'reinstall-target', podId: pod._id },
      { $set: { status: 'archived' } },
    );

    // Re-install — must NOT 500.
    const second = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        agentName: 'reinstall-target',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      });
    expect(second.status).toBe(200);

    expect((await request(app).get('/api/agents/runtime/events')
      .set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
    const replacement = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/reinstall-target/runtime-tokens`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ label: 'new runtime' });
    expect(replacement.status).toBe(200);
    expect(replacement.body.token).toMatch(/^cm_agent_/);

    // Confirm there's exactly ONE AgentProfile row and it's active.
    const profiles = await AgentProfile.find({ agentName: 'reinstall-target', podId: pod._id });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].status).toBe('active');
  });

  it('keeps an ephemeral name bound to its owner across uninstall and all instance ids', async () => {
    const name = 'my-private-seat';
    const ownerInstall = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(ownerInstall.status).toBe(200);
    const botBefore = await User.findOne({ username: name }).lean();
    expect(botBefore).toBeTruthy();
    expect(botBefore.botMetadata.ownerUserId).toBe(podMember._id.toString());
    expect((await request(app)
      .delete(`/api/registry/agents/${name}/pods/${pod._id}`)
      .set('Authorization', `Bearer ${memberToken}`)).status).toBe(200);

    const anotherPod = await Pod.create({
      name: 'Outsider workspace', type: 'chat', createdBy: outsider._id, members: [outsider._id],
    });
    for (const instanceId of ['default', 'another-instance']) {
      const refused = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ agentName: name, instanceId, podId: anotherPod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('agent_name_taken');
    }
    expect(await AgentInstallation.countDocuments({ agentName: name, podId: anotherPod._id })).toBe(0);
    expect((await User.findOne({ username: name }).lean())._id.toString()).toBe(botBefore._id.toString());

    const ownerReinstall = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(ownerReinstall.status).toBe(200);
    expect((await User.findOne({ username: name }).lean())._id.toString()).toBe(botBefore._id.toString());
  });

  it('refuses a second spelling that would derive another owner’s bot username', async () => {
    const first = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: 'my-private-seat', podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(first.status).toBe(200);
    const firstUser = await User.findOne({ username: 'my-private-seat' }).lean();
    const anotherPod = await Pod.create({
      name: 'Another owner', type: 'chat', createdBy: outsider._id, members: [outsider._id],
    });
    const collision = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ agentName: 'my-private', instanceId: 'seat', podId: anotherPod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(collision.status).toBe(409);
    expect(collision.body.code).toBe('agent_identity_conflict');
    expect(await AgentRegistry.findOne({ agentName: 'my-private' })).toBeNull();
    expect(await AgentInstallation.countDocuments({ agentName: 'my-private' })).toBe(0);
    expect((await User.findOne({ username: 'my-private-seat' }).lean())._id.toString()).toBe(firstUser._id.toString());
  });

  it('registry install refuses when the durable bot owner disagrees with its publisher', async () => {
    const name = 'my-owner-mismatch';
    const first = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(first.status).toBe(200);
    expect((await request(app).delete(`/api/registry/agents/${name}/pods/${pod._id}`)
      .set('Authorization', `Bearer ${memberToken}`)).status).toBe(200);
    await User.updateOne({ username: name }, { $set: { 'botMetadata.ownerUserId': outsider._id.toString() } });

    const refused = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('agent_identity_conflict');
    expect(await AgentInstallation.countDocuments({ agentName: name, status: 'active' })).toBe(0);
  });

  it('refuses to adopt an unowned legacy bot when its registry row is gone', async () => {
    const name = 'my-orphan-legacy';
    const first = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(first.status).toBe(200);
    const originalBot = await User.findOne({ username: name }).lean();

    // Simulate a pre-owner-stamp bot whose registry and installation rows
    // were removed outside the normal uninstall route. Its User and memory
    // still exist, but no durable owner record can validate a new installer.
    await AgentInstallation.deleteMany({ agentName: name });
    await AgentRegistry.deleteOne({ agentName: name });
    await User.updateOne({ _id: originalBot._id }, { $unset: { 'botMetadata.ownerUserId': '' } });

    const refused = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ agentName: name, podId: pod._id.toString(), config: { runtime: { runtimeType: 'webhook' } }, scopes: [] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('agent_identity_conflict');
    expect(await AgentRegistry.findOne({ agentName: name })).toBeNull();
    expect(await AgentInstallation.countDocuments({ agentName: name })).toBe(0);
    expect((await User.findOne({ username: name }).lean())._id.toString()).toBe(originalBot._id.toString());
  });

  it('marketplace catalog excludes ephemeral self-serve agents', async () => {
    // Create one published agent and one ephemeral via self-serve.
    await AgentRegistry.create({
      agentName: 'public-marketplace-bot',
      displayName: 'Public Bot',
      description: 'Catalog-visible',
      // The hire catalog is verified-only for non-admins since the ADR-022
      // Phase 0 gate — a listable fixture must say so explicitly, exactly as
      // a real listing does. The ephemeral row below stays unverified AND
      // ephemeral; its exclusion is what this test actually pins.
      verified: true,
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
