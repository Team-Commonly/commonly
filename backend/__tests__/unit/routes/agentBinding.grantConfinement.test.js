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

  describe('F94: a grant that names the seat', () => {
    const nameSeat = async (consent = true) => {
      const bot = await User.findOne({ 'botMetadata.agentName': AGENT_NAME }).lean();
      await User.updateOne({ _id: bot._id }, { $set: { botType: 'agent' } });
      await RoomGrant.updateMany({}, {
        $set: {
          ownerId: global.__CALLER_ID,
          byoAgents: [String(bot._id)],
          ...(consent ? {
            byoConsent: {
              by: global.__CALLER_ID, at: new Date(), version: 'byo-v1',
              agents: [{ userId: String(bot._id), sandbox: 'unconfined' }],
            },
          } : {}),
        },
      });
    };

    it('reaches a seat the server cannot confine, flagged as named', async () => {
      await seed({ mode: 'workspace', trust: 'private' });
      await nameSeat();
      const row = await assigned();
      const broker = row.environment.mcp.find((server) => server.name === GRANT_BROKER_ID);
      expect(broker).toMatchObject({ transport: 'http', byoNamed: true });
      expect(row.grantBrokerRefusal).toBeUndefined();
    });

    it('stays withheld once someone else also installs the seat\'s identity', async () => {
      await seed({ mode: 'workspace', trust: 'private' });
      await nameSeat();
      const other = await User.create({ username: `x${Date.now() % 1e6}`, email: `x${Date.now()}@x.com`, password: 'x'.repeat(12) });
      const otherPod = await Pod.create({ name: `q${Date.now()}`, createdBy: other._id, members: [other._id] });
      await AgentInstallation.create({
        agentName: AGENT_NAME, instanceId: 'default', podId: otherPod._id,
        version: '1.0.0', status: 'active', installedBy: other._id, config: {},
      });
      const row = await assigned();
      expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    });

    it('stays withheld when the grant carries no consent record', async () => {
      await seed({ mode: 'workspace', trust: 'private' });
      await nameSeat(false);
      const row = await assigned();
      expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
      expect(row.grantBrokerRefusal).toMatchObject({ reason: 'sandbox_trust_not_public' });
    });

    it('is not flagged on a seat the server can confine', async () => {
      await seed({ mode: 'workspace', trust: 'public' });
      await nameSeat();
      const row = await assigned();
      const broker = row.environment.mcp.find((server) => server.name === GRANT_BROKER_ID);
      expect(broker).toBeDefined();
      expect(broker.byoNamed).toBeUndefined();
    });
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
  // F175c: pi holds a grant only on a declared public seat. A pi seat that
  // declares nothing is never defaulted into a sandbox, so it is refused here,
  // with the reason naming does not lift.
  it('withholds the broker from a pi seat that declares no sandbox', async () => {
    await seed(undefined, { runtimeType: 'wrapper', adapter: 'pi', model: 'deepseek-v4-flash' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(mcpNames(row)).toContain('commonly');
    expect(row.grantBrokerRefusal).toMatchObject({
      code: GRANT_BROKER_REFUSAL_CODE,
      decidedBy: 'server',
      reason: 'adapter_confines_public_only',
    });
  });

  it('projects the broker to a public pi seat', async () => {
    await seed({ trust: 'public' }, { runtimeType: 'wrapper', adapter: 'pi', model: 'deepseek-v4-flash' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  // 2026-10-09: the denylist became an allowlist. An adapter nobody has shown to confine fails
  // closed, and a mode is judged against the declared adapter's own set, not the union.
  it('refuses a hand-attached seat whose runtimeType names an unproven adapter and carries no adapter key', async () => {
    // attach writes `runtime: { runtimeType: adapter.name, host: 'byo' }` with no `adapter` key.
    await seed({ mode: 'workspace', trust: 'public' }, { runtimeType: 'dsh', host: 'byo', model: 'x' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toMatchObject({ reason: 'adapter_cannot_confine' });
  });

  // F175d: a public seat on either harness holds the grant, and a hand-attached
  // one reads the same as a daemon-placed one.
  it.each([
    ['qwen', { runtimeType: 'qwen', host: 'byo', model: 'x' }],
    ['goose', { runtimeType: 'wrapper', adapter: 'goose', model: 'x' }],
  ])('projects the broker to a public %s seat, and withholds it from a private one', async (_adapter, runtime) => {
    await seed({ trust: 'public' }, runtime);
    const admitted = await assigned();
    expect(mcpNames(admitted)).toContain(GRANT_BROKER_ID);
    expect(admitted.grantBrokerRefusal).toBeUndefined();

    await seed({ trust: 'private' }, runtime);
    const refused = await assigned();
    expect(mcpNames(refused)).not.toContain(GRANT_BROKER_ID);
    expect(refused.grantBrokerRefusal).toMatchObject({ reason: 'adapter_confines_public_only' });
  });

  // F175d: the daemon derives Qwen's sandbox, so an absent block is its to judge
  // (cli default-environment.js). It derives none for Goose, so the server refuses.
  it('leaves a qwen seat with no sandbox block to the daemon, and refuses a goose one', async () => {
    await seed(undefined, { runtimeType: 'wrapper', adapter: 'qwen', model: 'x' });
    const qwen = await assigned();
    expect(mcpNames(qwen)).toContain(GRANT_BROKER_ID);

    await seed(undefined, { runtimeType: 'wrapper', adapter: 'goose', model: 'x' });
    const goose = await assigned();
    expect(mcpNames(goose)).not.toContain(GRANT_BROKER_ID);
    expect(goose.grantBrokerRefusal).toMatchObject({ reason: 'adapter_confines_public_only' });
  });

  it('leaves a wrapper row with no adapter key daemon-decided: a runtime kind is not an adapter', async () => {
    await seed({ mode: 'workspace', trust: 'public' }, { runtimeType: 'wrapper', model: 'claude-opus-5' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  it('withholds the broker from an adapter not known to confine, even with a confining-looking sandbox', async () => {
    await seed({ mode: 'workspace', trust: 'public' }, { runtimeType: 'wrapper', adapter: 'dsh', model: 'x' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toMatchObject({ code: GRANT_BROKER_REFUSAL_CODE, reason: 'adapter_cannot_confine' });
    expect(row.grantBrokerRefusal.detail).toContain('claude, codex, opencode');
  });

  // F175a: OpenCode joins the confining adapters on its three modes.
  it.each(['workspace', 'read-only', 'bwrap'])('injects the broker for a confined OpenCode seat (%s)', async (mode) => {
    await seed({ mode, trust: 'public' }, { runtimeType: 'wrapper', adapter: 'opencode', model: 'x' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  it('withholds the broker from an OpenCode seat whose mode is none', async () => {
    await seed({ mode: 'none', trust: 'public' }, { runtimeType: 'wrapper', adapter: 'opencode', model: 'x' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toMatchObject({ reason: 'sandbox_mode_none' });
  });

  it('withholds the broker when the mode is one the declared adapter does not enforce (codex + bwrap)', async () => {
    await seed({ mode: 'bwrap', trust: 'public' }, { runtimeType: 'wrapper', adapter: 'codex', model: 'gpt-6-luna' });
    const row = await assigned();
    expect(mcpNames(row)).not.toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toMatchObject({ reason: 'sandbox_mode_unenforceable' });
    expect(row.grantBrokerRefusal.detail).toContain("'codex' adapter");
  });

  it('injects the broker for a mode the declared adapter does enforce (claude + bwrap)', async () => {
    await seed({ mode: 'bwrap', trust: 'public' }, { runtimeType: 'wrapper', adapter: 'claude', model: 'claude-opus-5' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });

  it('leaves a claude seat with no sandbox block to the daemon, adapter and all', async () => {
    await seed(undefined, { runtimeType: 'wrapper', adapter: 'claude', model: 'claude-opus-5' });
    const row = await assigned();
    expect(mcpNames(row)).toContain(GRANT_BROKER_ID);
    expect(row.grantBrokerRefusal).toBeUndefined();
  });
});
