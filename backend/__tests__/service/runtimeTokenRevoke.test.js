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
const mockOwner = { id: new mongoose.Types.ObjectId().toString() };

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
app.use('/api/registry', require('../../routes/registry/admin'));
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
  });
});
