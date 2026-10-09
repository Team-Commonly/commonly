// TASK-063 server half: the /assigned projection must not hand a seat a grant
// broker it cannot be held to. The refusal is the narrow one — only a
// declaration NO host would confine — so the two rows that must still receive
// the broker are the load-bearing ones here: a public trust whose mode the
// daemon derives per host, and an absent sandbox block.
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
const { GRANT_BROKER_ID } = require('../../../services/installable/toolInstallables');
const { GRANT_BROKER_REFUSAL_CODE } = require('../../../services/grantBrokerConfinement');

let mongod; let app; let User; let AgentCredential; let AgentInstallation; let Machine; let Pod; let RoomGrant;
const DAEMON = `cm_daemon_${'c'.repeat(32)}`;
const AGENT_NAME = 'confinement-test';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  User = require('../../../models/User');
  AgentCredential = require('../../../models/AgentCredential');
  Machine = require('../../../models/Machine');
  Pod = require('../../../models/Pod');
  RoomGrant = require('../../../models/RoomGrant');
  AgentInstallation = require('../../../models/AgentRegistry').AgentInstallation;
  app = express();
  app.use(express.json());
  app.use('/api/agent-binding', require('../../../routes/agentBinding'));
});

afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

/**
 * One seat, one live room grant addressed at it, and a sandbox declaration.
 * `sandbox === undefined` seeds an installation with NO sandbox block, which is
 * the state a daemon-provisioned seat is in until the daemon writes its
 * baseline.
 */
const seed = async (sandbox, runtime = { runtimeType: 'wrapper', model: 'claude-opus-5' }) => {
  await Promise.all([
    User.deleteMany({}), AgentCredential.deleteMany({}), AgentInstallation.deleteMany({}),
    Machine.deleteMany({}), Pod.deleteMany({}), RoomGrant.deleteMany({}),
  ]);
  const tag = Date.now();
  const owner = await User.create({ username: `o${tag % 1e6}`, email: `o${tag}@x.com`, password: 'x'.repeat(12) });
  global.__CALLER_ID = String(owner._id);
  const bot = await User.create({
    username: `b${tag % 1e6}`, email: `b${tag}@agents.commonly.local`, password: 'x'.repeat(12),
    isBot: true,
    botMetadata: { agentName: AGENT_NAME, instanceId: 'default', machineId: 'machine-a' },
  });
  const pod = await Pod.create({ name: `p${tag}`, createdBy: owner._id, members: [owner._id, bot._id] });
  const environment = {
    version: 1,
    model: 'claude-opus-5',
    mcp: [{
      name: 'commonly',
      transport: 'stdio',
      command: ['npx', 'commonly-mcp'],
      env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
    }],
  };
  if (sandbox) environment.sandbox = sandbox;
  await AgentInstallation.create({
    agentName: AGENT_NAME, instanceId: 'default', podId: pod._id,
    version: '1.0.0', status: 'active', installedBy: owner._id,
    config: { runtime, environment },
  });
  await AgentCredential.create({
    tokenHash: hash(DAEMON), kind: 'daemon', ownerUserId: owner._id,
    machineId: 'machine-a', scopes: ['machine:heartbeat', 'agents:adopt'],
  });
  await Machine.create({ ownerUserId: owner._id, machineId: 'machine-a', name: 'Mac A' });
  // A live, unexpired grant whose target and audience are this seat — i.e. the
  // projection is about to inject the broker into the environment above.
  await RoomGrant.create({
    grantId: `grant_${tag}`, connectionId: 'conn-test', installationId: 'gh-install-1',
    brokerId: GRANT_BROKER_ID, target: { kind: 'seat', id: String(bot._id) },
    audience: [String(bot._id)], tools: ['read_file'], writeMode: 'read',
    budget: { calls: 10, windowMs: 60_000 },
    expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null,
  });
};

const assigned = async () => {
  const res = await request(app)
    .get('/api/agent-binding/assigned')
    .set('Authorization', `Bearer ${DAEMON}`);
  expect(res.status).toBe(200);
  const row = res.body.agents.find((agent) => agent.agentName === AGENT_NAME);
  expect(row).toBeDefined();
  return row;
};

const mcpNames = (row) => (row.environment?.mcp || []).map((server) => server.name);

describe('GET /assigned — grant broker confinement', () => {
  it('injects the broker into a confined seat and reports no refusal', async () => {
    await seed({ mode: 'workspace', trust: 'public' });
    const row = await assigned();
    expect(mcpNames(row)).toEqual(expect.arrayContaining(['commonly', GRANT_BROKER_ID]));
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  it('reads a legacy internal trust as confined, so the broker still arrives', async () => {
    await seed({ mode: 'workspace', trust: 'internal' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  it('withholds the broker from a seat no host can confine, and says why', async () => {
    await seed({ mode: 'workspace', trust: 'private' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    // The environment's OWN entries are untouched: only the injected grant
    // server is withheld.
    expect(mcpNames(row)).toContain('commonly');
    expect(row.grantBrokerRefusal).toMatchObject({
      code: GRANT_BROKER_REFUSAL_CODE,
      decidedBy: 'server',
      reason: 'sandbox_trust_not_public',
    });
    // The declaration itself is not rewritten — the refusal is a report about
    // it, not a silent edit of the seat's environment.
    expect(row.environment.sandbox).toEqual({ mode: 'workspace', trust: 'private' });
  });

  it('withholds the broker when the declared mode is none', async () => {
    await seed({ mode: 'none', trust: 'public' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toMatchObject({ reason: 'sandbox_mode_none' });
  });

  it('keeps the refusal out of the environment object the adapter receives', async () => {
    await seed({ mode: 'none', trust: 'public' });
    const row = await assigned();
    expect(row.environment.grantBrokerRefusal).toBeUndefined();
    expect(row.grantBrokerRefusal).toBeDefined();
  });

  it('leaves an absent sandbox block to the daemon rather than refusing the seat', async () => {
    await seed(undefined);
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  it('leaves a public trust with no declared mode to the daemon, which derives it per host', async () => {
    await seed({ trust: 'public' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  // The adapter reaches the predicate from the ROW (`config.runtime.adapter`),
  // so this case proves the wiring and not just the table. pi confines on no
  // host: its assertNoSandboxDeclared throws only on a DECLARED sandbox, and
  // nothing ever derives one, so a pi seat with a live grant must not be handed
  // the broker — which is the pi half of TASK-063. Once #1764 lands, pi can
  // speak the HTTP transport the broker uses, so this is what makes that
  // reachable-but-confined rather than reachable-and-bare.
  it('withholds the broker from a pi seat, which confines on no host', async () => {
    await seed(undefined, { runtimeType: 'wrapper', adapter: 'pi', model: 'deepseek-v4-flash' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(mcpNames(row)).toContain('commonly');
    expect(row.grantBrokerRefusal).toMatchObject({
      code: GRANT_BROKER_REFUSAL_CODE,
      decidedBy: 'server',
      reason: 'adapter_cannot_confine',
    });
  });

  it('leaves a claude seat with no sandbox block to the daemon, adapter and all', async () => {
    await seed(undefined, { runtimeType: 'wrapper', adapter: 'claude', model: 'claude-opus-5' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });
});
