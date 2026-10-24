// A revoked runtime token must stop authenticating, everywhere it is stored
// (P0 from the #2194 grading, TASK-252). Issuing writes the token to the
// agent's User row AND to the installation it was issued through, and each
// copy gets its own subdocument _id. The revoke routes matched by that id, so
// they removed one copy and left the other: QA revoked a token, saw the list
// go to 0, and the same token kept passing runtime auth through the
// installation copy until that installation was uninstalled.
//
// This is a real mongod because the claim is about which stored copies a
// revoke reaches; a mocked model only reports the filter it was handed. The
// probe is the real runtime auth middleware, so "dead" means what an agent
// would see: its next call is a 401.
const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

// The signed-in human. A jest.mock factory may only reach `mock`-prefixed
// bindings, read at call time.
const primaryOwnerId = new mongoose.Types.ObjectId().toString();
const mockOwner = { id: primaryOwnerId };

jest.mock('../../middleware/auth', () => {
  const auth = (req, _res, next) => {
    req.userId = mockOwner.id;
    req.user = { id: mockOwner.id };
    next();
  };
  auth.touchLastActive = () => {};
  return auth;
});
jest.mock('../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../services/starterTaskService', () => ({ completeConnectAgentStarterTask: jest.fn() }));

const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
const agentRuntimeAuth = require('../../middleware/agentRuntimeAuth');

const app = express();
app.use(express.json());
app.use('/api/registry', require('../../routes/registry/agent-tokens'));
app.use('/api/credentials', require('../../routes/credentials'));
app.use('/api/registry', require('../../routes/registry/admin'));
app.use('/api/registry', require('../../routes/registry/pod-agents'));
// A limiter far above anything this suite sends: the probe is a test route,
// but it runs the database-backed auth middleware, and the repo's CodeQL
// rule (js/missing-rate-limiting) reads test files too.
const probeLimit = rateLimit({ windowMs: 60 * 1000, max: 10000 });
app.get('/probe', probeLimit, agentRuntimeAuth, (req, res) => res.json({ agent: req.agentUser?.username || null }));

const AGENT = 'maya-claude';

const probe = (token) => request(app).get('/probe').set('Authorization', `Bearer ${token}`);

const seed = async () => {
  const owner = mockOwner.id;
  const workspace = await Pod.create({ name: 'My Workspace', type: 'chat', createdBy: owner, members: [owner] });
  const room = await Pod.create({ name: 'Room', type: 'chat', createdBy: owner, members: [owner] });
  const install = (pod) => AgentInstallation.create({
    agentName: AGENT,
    instanceId: 'default',
    podId: pod._id,
    installedBy: owner,
    status: 'active',
    displayName: 'Maya Claude',
    version: '1.0.0',
  });
  const workspaceInstall = await install(workspace);
  const roomInstall = await install(room);
  return { workspace, room, workspaceInstall, roomInstall };
};

const storesHolding = async (tokenHash) => ({
  users: await User.countDocuments({ 'agentRuntimeTokens.tokenHash': tokenHash }),
  installations: await AgentInstallation.countDocuments({ 'runtimeTokens.tokenHash': tokenHash }),
});

describe('revoking a runtime token kills it in every store', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    mockOwner.id = primaryOwnerId;
    await clearMongoDb();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('the owner revoking it from the token list: the next runtime call is a 401', async () => {
    const { workspace } = await seed();
    const issued = await request(app)
      .post(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`)
      .send({ label: 'laptop' });
    expect(issued.status).toBe(200);
    const { token } = issued.body;
    // Positive control: the token works, and it sits in both stores.
    expect((await probe(token)).status).toBe(200);
    const tokenHash = (await User.findOne({ 'agentRuntimeTokens.0': { $exists: true } }).lean())
      .agentRuntimeTokens[0].tokenHash;
    expect(await storesHolding(tokenHash)).toEqual({ users: 1, installations: 1 });

    const listed = await request(app).get(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`);
    const tokenId = listed.body.tokens[0].id || listed.body.tokens[0]._id;
    const revoked = await request(app)
      .delete(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens/${tokenId}`);
    expect(revoked.status).toBe(200);

    expect((await probe(token)).status).toBe(401);
    expect(await storesHolding(tokenHash)).toEqual({ users: 0, installations: 0 });
    const history = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(history.status).toBe(200);
    expect(history.body).toEqual([expect.objectContaining({
      label: 'laptop', status: 'revoked', revokedAt: expect.any(String),
    })]);
    expect(JSON.stringify(history.body)).not.toContain(token);
  });

  test('a pod member who did not install the identity cannot list key metadata', async () => {
    const { workspace } = await seed();
    const issued = await request(app)
      .post(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`)
      .send({ label: 'private laptop' });
    expect(issued.status).toBe(200);
    const otherId = new mongoose.Types.ObjectId().toString();
    const credential = await AgentCredential.findOne({ label: 'private laptop' }).lean();
    await Pod.updateOne({ _id: workspace._id }, { $push: { members: otherId } });
    mockOwner.id = otherId;
    const listed = await request(app).get(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`);
    expect(listed.status).toBe(403);
    expect(JSON.stringify(listed.body)).not.toContain('private laptop');
    const credentials = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(credentials.status).toBe(403);
    expect(JSON.stringify(credentials.body)).not.toContain('private laptop');
    const revoke = await request(app).delete(`/api/credentials/${credential._id}?agentName=${AGENT}&instanceId=default`);
    expect(revoke.status).toBe(403);
    expect((await AgentCredential.findById(credential._id).lean()).status).toBe('active');
  });

  test('an instance admin can read a key-bearing installation without joining its pod', async () => {
    const { workspace } = await seed();
    const issued = await request(app)
      .post(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`)
      .send({ label: 'owner key' });
    expect(issued.status).toBe(200);
    const adminId = new mongoose.Types.ObjectId();
    await User.create({ _id: adminId, username: 'settings-admin', email: 'settings-admin@example.test',
      role: 'admin', authProviders: [{ provider: 'github', providerId: 'settings-admin' }] });
    mockOwner.id = String(adminId);
    const installation = await request(app)
      .get(`/api/registry/pods/${workspace._id}/agents/${AGENT}?instanceId=default`);
    expect(installation.status).toBe(200);
    const keys = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(keys.status).toBe(200);
  });

  test('the Settings credential revoke stops the agent token and keeps its history', async () => {
    const { workspace, workspaceInstall } = await seed();
    const issued = await request(app)
      .post(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`)
      .send({ label: 'Settings key' });
    expect((await probe(issued.body.token)).status).toBe(200);
    const listed = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({
      label: 'Settings key', status: 'active', lastUsedAt: expect.any(String),
    })]);
    const tokenHash = (await User.findOne({ 'agentRuntimeTokens.0': { $exists: true } }).lean())
      .agentRuntimeTokens[0].tokenHash;
    expect(await storesHolding(tokenHash)).toEqual({ users: 1, installations: 1 });
    workspaceInstall.config = new Map([['runtime', { runtimeType: 'webhook' }]]);
    await workspaceInstall.save();
    await AgentCredential.updateOne({ tokenHash }, { $set: { lastUsedAt: new Date() } });
    const beforeCard = await request(app).get(`/api/registry/pods/${workspace._id}/agents`);
    expect(beforeCard.status).toBe(200);
    expect(beforeCard.body.agents[0].connection.state).toBe('connected');
    const revoked = await request(app).delete(`/api/credentials/${listed.body[0]._id}?agentName=${AGENT}&instanceId=default`);
    expect(revoked.status).toBe(200);
    expect((await probe(issued.body.token)).status).toBe(401);
    expect(await storesHolding(tokenHash)).toEqual({ users: 0, installations: 0 });
    expect((await AgentInstallation.findById(workspaceInstall._id).lean()).runtimeTokens).toHaveLength(0);
    const afterCard = await request(app).get(`/api/registry/pods/${workspace._id}/agents`);
    expect(afterCard.status).toBe(200);
    expect(afterCard.body.agents[0].connection).toEqual({ state: 'revoked', lastSeenAt: null });
    const after = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(after.body).toEqual([expect.objectContaining({ label: 'Settings key', status: 'revoked' })]);
  });

  test('an existing embedded key is imported into Settings before it is revoked', async () => {
    const { workspaceInstall } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const issued = await issueRuntimeTokenForAgent(agentUser, 'Old CLI key', workspaceInstall);
    expect(await AgentCredential.countDocuments({ agentUserId: agentUser._id })).toBe(0);
    const listed = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ label: 'Old CLI key', status: 'active' })]);
    const revoked = await request(app).delete(`/api/credentials/${listed.body[0]._id}?agentName=${AGENT}&instanceId=default`);
    expect(revoked.status).toBe(200);
    expect((await probe(issued.token)).status).toBe(401);
    expect((await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`)).body)
      .toEqual([expect.objectContaining({ label: 'Old CLI key', status: 'revoked' })]);
    expect((await User.findById(agentUser._id).lean()).agentRuntimeTokens).toHaveLength(0);
    expect((await AgentInstallation.findById(workspaceInstall._id).lean()).runtimeTokens).toHaveLength(0);
  });

  test('an installation-only legacy key remains visible for owner revocation', async () => {
    const { workspaceInstall } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const issued = await issueRuntimeTokenForAgent(agentUser, 'Installation key', workspaceInstall);
    await User.updateOne({ _id: agentUser._id }, { $set: { agentRuntimeTokens: [] } });
    expect((await probe(issued.token)).status).toBe(200);
    const listed = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ label: 'Installation key', status: 'active' })]);
    const revoked = await request(app).delete(`/api/credentials/${listed.body[0]._id}?agentName=${AGENT}&instanceId=default`);
    expect(revoked.status).toBe(200);
    expect((await probe(issued.token)).status).toBe(401);
  });

  test('a copy on a sibling installation dies too, and so does a ledger row', async () => {
    const { workspace, roomInstall } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    // Issued with an issuer, so the credential ledger holds it as well, and
    // copied onto a second installation the way an older issue path left it.
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'daemon', roomInstall, { ownerUserId: mockOwner.id });
    const fresh = await User.findById(agentUser._id).lean();
    const record = fresh.agentRuntimeTokens[0];
    await AgentInstallation.updateOne(
      { podId: workspace._id },
      { $push: { runtimeTokens: { tokenHash: record.tokenHash, label: record.label, createdAt: record.createdAt } } },
    );
    expect(await storesHolding(record.tokenHash)).toEqual({ users: 1, installations: 2 });
    expect((await probe(token)).status).toBe(200);
    // The room install is later uninstalled. Its copy must still go: a
    // reinstall reuses the row, and a copy left on it would come back to life.
    await AgentInstallation.updateOne({ _id: roomInstall._id }, { $set: { status: 'uninstalled' } });

    const revoked = await request(app)
      .delete(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens/${record._id}`);
    expect(revoked.status).toBe(200);

    expect((await probe(token)).status).toBe(401);
    expect(await storesHolding(record.tokenHash)).toEqual({ users: 0, installations: 0 });
    const ledger = await AgentCredential.findOne({ tokenHash: record.tokenHash }).lean();
    expect(ledger.status).toBe('revoked');
  });

  test('an admin revoking it from one installation: the next runtime call is a 401', async () => {
    const { workspace, workspaceInstall } = await seed();
    const issued = await request(app)
      .post(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens`)
      .send({ label: 'laptop' });
    const { token } = issued.body;
    expect((await probe(token)).status).toBe(200);
    const installed = await AgentInstallation.findById(workspaceInstall._id).lean();
    const installationTokenId = installed.runtimeTokens[0]._id;

    const revoked = await request(app)
      .delete(`/api/registry/admin/installations/${workspaceInstall._id}/runtime-tokens/${installationTokenId}`);
    expect(revoked.status).toBe(200);

    expect((await probe(token)).status).toBe(401);
    expect(await storesHolding(installed.runtimeTokens[0].tokenHash)).toEqual({ users: 0, installations: 0 });
  });

  test('revoking one token leaves another token of the same agent working', async () => {
    const { workspace, roomInstall } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const first = await issueRuntimeTokenForAgent(agentUser, 'laptop', roomInstall);
    // A second token for the same identity, as a daemon or rotation leaves.
    const { randomSecret, hash } = require('../../utils/secret');
    const second = `cm_agent_${randomSecret(32)}`;
    await User.updateOne(
      { _id: agentUser._id },
      { $push: { agentRuntimeTokens: { tokenHash: hash(second), label: 'desktop', createdAt: new Date() } } },
    );
    const fresh = await User.findById(agentUser._id).lean();
    const firstRecord = fresh.agentRuntimeTokens.find((t) => t.label === 'laptop');

    const revoked = await request(app)
      .delete(`/api/registry/pods/${workspace._id}/agents/${AGENT}/runtime-tokens/${firstRecord._id}`);
    expect(revoked.status).toBe(200);

    expect((await probe(first.token)).status).toBe(401);
    expect((await probe(second)).status).toBe(200);
    const history = await request(app).get(`/api/credentials?agentName=${AGENT}&instanceId=default`);
    expect(history.status).toBe(200);
    expect(history.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'laptop', status: 'revoked', revokedAt: expect.any(String) }),
      expect.objectContaining({ label: 'desktop', status: 'active', revokedAt: null }),
    ]));
  });

  test('pod uninstall keeps a shared token until the last installation, then revokes it and preserves identity', async () => {
    const { workspace, room } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'laptop', null, { ownerUserId: mockOwner.id });
    const tokenHash = agentUser.agentRuntimeTokens[0].tokenHash;
    expect((await probe(token)).status).toBe(200);

    const first = await request(app).delete(`/api/registry/agents/${AGENT}/pods/${workspace._id}`);
    expect(first.status).toBe(200);
    expect((await probe(token)).status).toBe(200);

    const last = await request(app).delete(`/api/registry/agents/${AGENT}/pods/${room._id}`);
    expect(last.status).toBe(200);
    expect((await probe(token)).status).toBe(401);
    expect(await storesHolding(tokenHash)).toEqual({ users: 0, installations: 0 });
    expect((await AgentCredential.findOne({ tokenHash }).lean()).status).toBe('revoked');
    expect(await User.findById(agentUser._id)).toBeTruthy();
  });

  test('admin uninstall also revokes a ledger-only child on the last installation', async () => {
    const { workspaceInstall, roomInstall } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const parent = await issueRuntimeTokenForAgent(agentUser, 'parent', null, { ownerUserId: mockOwner.id });
    const { hash, randomSecret } = require('../../utils/secret');
    const child = `cm_agent_${randomSecret(32)}`;
    await AgentCredential.create({
      tokenHash: hash(child), kind: 'runtime', ownerUserId: mockOwner.id,
      agentUserId: agentUser._id, scopes: ['spawn'], status: 'active',
    });
    expect((await probe(child)).status).toBe(200);

    expect((await request(app).delete(`/api/registry/admin/installations/${workspaceInstall._id}`)).status).toBe(200);
    expect((await probe(parent.token)).status).toBe(200);
    expect((await probe(child)).status).toBe(200);

    expect((await request(app).delete(`/api/registry/admin/installations/${roomInstall._id}`)).status).toBe(200);
    expect((await probe(parent.token)).status).toBe(401);
    expect((await probe(child)).status).toBe(401);
    expect((await AgentCredential.findOne({ tokenHash: hash(child) }).lean()).status).toBe('revoked');
  });

  test('orphan removal revokes a bearer left after installation rows disappeared', async () => {
    const { workspace } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'orphan', null, { ownerUserId: mockOwner.id });
    await AgentInstallation.deleteMany({ agentName: AGENT });
    await User.create({
      _id: mockOwner.id, username: 'runtime-token-admin', email: 'runtime-token-admin@test.com',
      password: 'password123', role: 'admin',
    });
    expect((await request(app).delete(`/api/registry/agents/${AGENT}/pods/${workspace._id}`)).status).toBe(200);
    expect((await probe(token)).status).toBe(401);
    expect((await User.findById(agentUser._id)).agentRuntimeTokens).toHaveLength(0);
  });

  test('a pod creator cannot revoke identity-wide orphan credentials without a local artifact', async () => {
    const { workspace } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    await issueRuntimeTokenForAgent(agentUser, 'orphan', null, { ownerUserId: mockOwner.id });
    await AgentInstallation.deleteMany({ agentName: AGENT });

    const result = await request(app).delete(`/api/registry/agents/${AGENT}/pods/${workspace._id}`);
    expect(result.status).toBe(404);
    expect((await User.findById(agentUser._id)).agentRuntimeTokens).toHaveLength(1);
  });

  test('a pod creator can clean orphan credentials when that bot is still a member', async () => {
    const { workspace } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    workspace.members.push(agentUser._id);
    await workspace.save();
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'orphan', null, { ownerUserId: mockOwner.id });
    await AgentInstallation.deleteMany({ agentName: AGENT });

    const result = await request(app).delete(`/api/registry/agents/${AGENT}/pods/${workspace._id}`);
    expect(result.status).toBe(200);
    expect((await probe(token)).status).toBe(401);
    expect((await Pod.findById(workspace._id)).members.map(String)).not.toContain(String(agentUser._id));
  });

  test('an instance name or unknown name cannot report orphan removal while an install remains', async () => {
    const { workspace } = await seed();
    const hosted = await AgentInstallation.create({
      agentName: 'native', instanceId: 'scout', podId: workspace._id,
      installedBy: mockOwner.id, status: 'active', version: '1.0.0',
    });

    for (const name of ['scout', 'not-installed']) {
      const result = await request(app).delete(`/api/registry/agents/${name}/pods/${workspace._id}`);
      expect(result.status).toBe(404);
      expect(result.body.error).toMatch(/agentName.*instanceId/);
      expect(result.body.removedOrphan).toBeUndefined();
      expect((await AgentInstallation.findById(hosted._id)).status).toBe('active');
    }

    const correct = await request(app)
      .delete(`/api/registry/agents/native/pods/${workspace._id}?instanceId=scout`);
    expect(correct.status).toBe(200);
    expect((await AgentInstallation.findById(hosted._id)).status).toBe('uninstalled');
  });

  test('a token for an installation in another pod does not make an unknown pod uninstall succeed', async () => {
    const { workspace } = await seed();
    const other = await Pod.create({
      name: 'Other', type: 'chat', createdBy: mockOwner.id, members: [mockOwner.id],
    });
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'other-pod', null, {
      ownerUserId: mockOwner.id,
    });

    const result = await request(app).delete(`/api/registry/agents/${AGENT}/pods/${other._id}`);
    expect(result.status).toBe(404);
    expect((await probe(token)).status).toBe(200);
    expect((await AgentInstallation.findOne({ agentName: AGENT, podId: workspace._id })).status)
      .toBe('active');
  });

  test('a colliding derived username cannot clean another installed agent identity', async () => {
    const { workspace } = await seed();
    const hosted = await AgentInstallation.create({
      agentName: 'native', instanceId: 'scout', podId: workspace._id,
      installedBy: mockOwner.id, status: 'active', version: '1.0.0',
    });
    const agentUser = await AgentIdentityService.getOrCreateAgentUser('native', { instanceId: 'scout' });
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'colliding', null, {
      ownerUserId: mockOwner.id,
    });

    const result = await request(app).delete(`/api/registry/agents/native-scout/pods/${workspace._id}`);
    expect(result.status).toBe(404);
    expect((await AgentInstallation.findById(hosted._id)).status).toBe('active');
    expect((await probe(token)).status).toBe(200);
  });

  test('a legacy alias cannot remove the canonical installation membership', async () => {
    const { workspace } = await seed();
    const canonical = await AgentInstallation.create({
      agentName: 'commonly-bot', instanceId: 'default', podId: workspace._id,
      installedBy: mockOwner.id, status: 'active', version: '1.0.0',
    });
    const agentUser = await AgentIdentityService.getOrCreateAgentUser('commonly-bot', {
      instanceId: 'default',
    });
    workspace.members.push(agentUser._id);
    await workspace.save();

    const result = await request(app)
      .delete(`/api/registry/agents/commonly-summarizer/pods/${workspace._id}`);
    expect(result.status).toBe(404);
    expect(result.body.error).toMatch(/commonly-bot.*instanceId/);
    expect((await AgentInstallation.findById(canonical._id)).status).toBe('active');
    expect((await Pod.findById(workspace._id)).members.map(String)).toContain(String(agentUser._id));
  });

  test('admin repeat uninstall cleans credentials stranded by an older path', async () => {
    const { workspaceInstall } = await seed();
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'old', null, { ownerUserId: mockOwner.id });
    await AgentInstallation.updateMany({ agentName: AGENT }, { $set: { status: 'uninstalled' } });

    const result = await request(app).delete(`/api/registry/admin/installations/${workspaceInstall._id}`);
    expect(result.status).toBe(200);
    expect(result.body.alreadyUninstalled).toBe(true);
    expect((await probe(token)).status).toBe(401);
    expect((await User.findById(agentUser._id)).agentRuntimeTokens).toHaveLength(0);
  });
});
