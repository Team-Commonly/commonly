// ADR-026 Phase 2 work surface on mongodb-memory-server: a placement request
// is a directive (never a binding), the daemon work list is scoped by the
// credential's machineId AND the owner's installation set, and the runtime
// mint requires the D3 binding, carries daemon lineage, and rotates totally
// (ledger + both legacy stores) or not at all.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => {
  const mw = (req, res, next) => { req.user = { id: global.__CALLER_ID }; next(); };
  mw.touchLastActive = jest.fn();
  return mw;
});

const { hash } = require('../../../utils/secret');

let mongod; let app; let AgentCredential; let User; let AgentInstallation; let Machine;
const DAEMON_A = `cm_daemon_${'a'.repeat(32)}`;
const DAEMON_B = `cm_daemon_${'b'.repeat(32)}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentCredential = require('../../../models/AgentCredential');
  User = require('../../../models/User');
  Machine = require('../../../models/Machine');
  AgentInstallation = require('../../../models/AgentRegistry').AgentInstallation;
  app = express();
  app.use(express.json());
  app.use('/api/agent-binding', require('../../../routes/agentBinding'));
});

afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let owner; let bot; let daemonCredA;
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), AgentCredential.deleteMany({}), AgentInstallation.deleteMany({}), Machine.deleteMany({}),
  ]);
  owner = await User.create({ username: `o${Date.now() % 1e6}`, email: `o${Date.now()}@x.com`, password: 'x'.repeat(12) });
  global.__CALLER_ID = String(owner._id);
  bot = await User.create({
    username: `b${Date.now() % 1e6}`, email: `b${Date.now()}@agents.commonly.local`, password: 'x'.repeat(12),
    isBot: true, botMetadata: { agentName: 'wren-test', instanceId: 'default' },
  });
  await AgentInstallation.create({
    agentName: 'wren-test', instanceId: 'default', podId: new mongoose.Types.ObjectId(),
    version: '1.0.0', status: 'active', installedBy: owner._id,
    config: {
      runtime: { runtimeType: 'wrapper', model: 'claude-opus-5' },
      environment: {
        version: 1,
        workspace: { path: './workspace', seed: 'workspace-seed' },
        sandbox: {
          mode: 'workspace',
          trust: 'internal',
          network: { policy: 'allow', 'allow-hosts': ['api.commonly.me'] },
          filesystem: { 'read-outside': false, 'write-outside': false },
        },
        skills: { claude: ['common'], commonly: ['decision-cards'] },
        mcp: [{
          name: 'commonly',
          transport: 'stdio',
          url: 'https://mcp.commonly.me',
          command: ['npx', 'commonly-mcp'],
          env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
        }],
        model: 'gpt-5.4',
        effort: 'high',
        privateKey: 'must-not-travel',
      },
    },
  });
  for (const [tok, mid] of [[DAEMON_A, 'machine-a'], [DAEMON_B, 'machine-b']]) {
    // eslint-disable-next-line no-await-in-loop
    const cred = await AgentCredential.create({
      tokenHash: hash(tok), kind: 'daemon', ownerUserId: owner._id, machineId: mid, scopes: ['machine:heartbeat', 'agents:adopt'],
    });
    if (mid === 'machine-a') daemonCredA = cred;
  }
  await Machine.create({ ownerUserId: owner._id, machineId: 'machine-a', name: 'Mac A' });
  await Machine.create({ ownerUserId: owner._id, machineId: 'machine-b', name: 'Mac B' });
});

const requestPlacement = (machineId) => request(app)
  .post('/api/agent-binding/request')
  .send({ agentName: 'wren-test', instanceId: 'default', machineId });

const adopt = (tok) => request(app)
  .post('/api/agent-binding/adopt')
  .set('Authorization', `Bearer ${tok}`)
  .send({ agentName: 'wren-test', instanceId: 'default' });

const assigned = (tok) => request(app)
  .get('/api/agent-binding/assigned')
  .set('Authorization', `Bearer ${tok}`);

const mint = (tok, body = {}) => request(app)
  .post('/api/agent-binding/runtime-token')
  .set('Authorization', `Bearer ${tok}`)
  .send({ agentName: 'wren-test', instanceId: 'default', ...body });

describe('placement request', () => {
  it('records a directive without binding, and null withdraws it', async () => {
    const res = await requestPlacement('machine-a');
    expect(res.status).toBe(200);
    let identity = await User.findById(bot._id).lean();
    expect(identity.botMetadata.requestedMachineId).toBe('machine-a');
    expect(identity.botMetadata.machineId ?? null).toBeNull();

    const withdrawn = await requestPlacement(null);
    expect(withdrawn.status).toBe(200);
    identity = await User.findById(bot._id).lean();
    expect(identity.botMetadata.requestedMachineId).toBeNull();
  });

  it('404s a machine the caller does not own', async () => {
    await Machine.updateOne({ machineId: 'machine-b' }, { ownerUserId: new mongoose.Types.ObjectId() });
    const res = await requestPlacement('machine-b');
    expect(res.status).toBe(404);
  });

  it('403s a caller without the installation', async () => {
    global.__CALLER_ID = String(new mongoose.Types.ObjectId());
    const res = await requestPlacement('machine-a');
    expect(res.status).toBe(403);
  });

  it('409s when the agent is bound to a different machine', async () => {
    await User.updateOne({ _id: bot._id }, { $set: { 'botMetadata.machineId': 'machine-b' } });
    const res = await requestPlacement('machine-a');
    expect(res.status).toBe(409);
    expect(res.body.boundTo).toBe('machine-b');
  });
});

describe('daemon work list', () => {
  it('shows a requested agent only to the requested machine, with its runtime config', async () => {
    await requestPlacement('machine-a');

    const seenByA = await assigned(DAEMON_A);
    expect(seenByA.status).toBe(200);
    expect(seenByA.body.agents[0].environment).not.toHaveProperty('privateKey');
    expect(seenByA.body.agents).toEqual([expect.objectContaining({
      agentName: 'wren-test',
      instanceId: 'default',
      state: 'requested',
      runtime: expect.objectContaining({ model: 'claude-opus-5' }),
      environment: expect.objectContaining({
        version: 1,
        workspace: { path: './workspace', seed: 'workspace-seed' },
        sandbox: {
          mode: 'workspace',
          trust: 'internal',
          network: { policy: 'allow', 'allow-hosts': ['api.commonly.me'] },
          filesystem: { 'read-outside': false, 'write-outside': false },
        },
        skills: { claude: ['common'], commonly: ['decision-cards'] },
        mcp: [{
          name: 'commonly',
          transport: 'stdio',
          url: 'https://mcp.commonly.me',
          command: ['npx', 'commonly-mcp'],
          env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
        }],
        model: 'gpt-5.4',
        effort: 'high',
      }),
    })]);

    const seenByB = await assigned(DAEMON_B);
    expect(seenByB.body.agents).toEqual([]);
  });

  it('flips to bound after adopt, and adopt consumes the request', async () => {
    await requestPlacement('machine-a');
    expect((await adopt(DAEMON_A)).status).toBe(200);

    const identity = await User.findById(bot._id).lean();
    expect(identity.botMetadata.machineId).toBe('machine-a');
    expect(identity.botMetadata.requestedMachineId).toBeNull();

    const seenByA = await assigned(DAEMON_A);
    expect(seenByA.body.agents).toEqual([expect.objectContaining({ state: 'bound' })]);
  });

  it('excludes identities outside the owner installation set', async () => {
    // Another user's agent lands on the same machineId string — never listed.
    await User.create({
      username: 'stranger-bot', email: 'sb@agents.commonly.local', password: 'x'.repeat(12),
      isBot: true, botMetadata: { agentName: 'stranger-agent', instanceId: 'default', machineId: 'machine-a' },
    });
    const seenByA = await assigned(DAEMON_A);
    expect(seenByA.body.agents).toEqual([]);
  });

  it('does not expose an empty environment projection as a declared spec', async () => {
    const installation = await AgentInstallation.findOne({ agentName: 'wren-test' });
    installation.config.set('environment', { privateKey: 'must-not-travel' });
    await installation.save();
    await requestPlacement('machine-a');

    const seenByA = await assigned(DAEMON_A);
    expect(seenByA.status).toBe(200);
    expect(seenByA.body.agents[0]).not.toHaveProperty('environment');
  });
});

describe('runtime-token mint', () => {
  it('refuses an unbound agent', async () => {
    const res = await mint(DAEMON_A);
    expect(res.status).toBe(409);
  });

  it('mints a lineage-carrying credential for a bound agent', async () => {
    await adopt(DAEMON_A);
    const res = await mint(DAEMON_A);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect(res.body.rotated).toBe(false);

    const row = await AgentCredential.findOne({ kind: 'runtime', tokenHash: hash(res.body.token) }).lean();
    expect(row).toEqual(expect.objectContaining({
      machineId: 'machine-a',
      parentId: daemonCredA._id,
      status: 'active',
    }));
  });

  it('refuses to overwrite an existing token without rotate:true', async () => {
    await adopt(DAEMON_A);
    await mint(DAEMON_A);
    const res = await mint(DAEMON_A);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('token_exists');
  });

  it('rotate:true revokes the ledger row and clears both legacy stores', async () => {
    await adopt(DAEMON_A);
    const first = await mint(DAEMON_A);
    // Simulate the legacy installation-side copy the old attach flow wrote.
    await AgentInstallation.updateMany(
      { agentName: 'wren-test', instanceId: 'default' },
      { $set: { runtimeTokens: [{ tokenHash: hash(first.body.token), label: 'legacy copy', createdAt: new Date() }] } },
    );

    const second = await mint(DAEMON_A, { rotate: true });
    expect(second.status).toBe(201);
    expect(second.body.rotated).toBe(true);
    expect(second.body.token).not.toBe(first.body.token);

    const oldRow = await AgentCredential.findOne({ tokenHash: hash(first.body.token) }).lean();
    expect(oldRow.status).toBe('revoked');
    const identity = await User.findById(bot._id).lean();
    expect(identity.agentRuntimeTokens.map((t) => t.tokenHash)).toEqual([hash(second.body.token)]);
    const install = await AgentInstallation.findOne({ agentName: 'wren-test' }).lean();
    expect(install.runtimeTokens || []).toEqual([]);
  });

  it('never mints for a daemon whose machine does not hold the binding', async () => {
    await adopt(DAEMON_A);
    const res = await mint(DAEMON_B);
    expect(res.status).toBe(409);
    expect(res.body.boundTo).toBe('machine-a');
  });
});
