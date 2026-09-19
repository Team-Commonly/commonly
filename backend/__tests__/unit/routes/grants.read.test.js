/**
 * Tools plan §6 — the three read routes the page needs, by their named tests.
 * RoomGrant runs on memory Mongo (the query shape is the thing under test);
 * the pod, the connection owner and the Postgres trail are mocked at their
 * module boundaries, as the pod-agents route suite does.
 */
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

// Human identity from a header so one app can be called as several people.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
  req.userId = id;
  return next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  const id = req.get('x-test-agent');
  if (!id) return res.status(401).json({ error: 'agent_token_invalid' });
  req.agentUser = { _id: id };
  return next();
});
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/ToolCall', () => ({
  listForGrant: jest.fn(),
  countsForGrant: jest.fn(),
}));
// pods.ts ends with `router.get('/:type/:id', getPodById)`, which would answer
// `/:podId/grants` as type=<podId>, id='grants' if it were mounted first
// (Wren 67721 / Vera 67727). The controller is stubbed so that shadowing shows.
jest.mock('../../../controllers/podController', () => ({
  getAllPods: jest.fn((req, res) => res.status(500).json({ shadowed: 'getAllPods' })),
  getPodsByType: jest.fn((req, res) => res.status(500).json({ shadowed: 'getPodsByType' })),
  getPodById: jest.fn((req, res) => res.status(500).json({ shadowed: 'getPodById', params: req.params })),
  createPod: jest.fn(), joinPod: jest.fn(), leavePod: jest.fn(), removeMember: jest.fn(), deletePod: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn(async (userId, pod) => (pod.members || []).map(String).includes(String(userId))),
}));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const ToolCall = require('../../../models/ToolCall');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01'; // installed the App: every grant's granter
const MEMBER = 'bbbbbbbbbbbbbbbbbbbbbb02';
const STRANGER = 'bbbbbbbbbbbbbbbbbbbbbb03';
const SEAT = 'cccccccccccccccccccccc01'; // an agent user in the pod
const OTHER_SEAT = 'cccccccccccccccccccccc02';
const GONE = 'dddddddddddddddddddddd01'; // in the audience snapshot, no longer a member

let mongod;
let RoomGrant;
let app;

const grant = (over = {}) => ({
  grantId: `grant_${Math.random().toString(36).slice(2)}`,
  connectionId: 'conn-1',
  installationId: 'install-1',
  target: { kind: 'pod', id: POD },
  tools: ['github.list_issues', 'github.comment'],
  writeMode: 'write-with-confirm',
  budget: { calls: 10, windowMs: 60000 },
  audience: [SEAT, GONE],
  expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  brokerId: 'broker-1',
  ...over,
});

const trailRow = (over = {}) => ({
  callId: 'call-1', grantId: 'g', podId: POD, installationId: 'install-1', agentUserId: SEAT,
  tool: 'github.list_issues', argsDigest: 'a'.repeat(64), at: new Date('2026-09-11T04:00:00.000Z'),
  outcome: 'ok', reason: undefined, approvalId: undefined, durationMs: 120,
  // What the trail must never carry, even if a row somehow did.
  args: { repo: 'secret/private' },
  ...over,
});

// `grantBrokerRefusal` + its scope are the TASK-063 addition: the read now says
// whether the daemon-facing projection would withhold the broker from this
// seat. The scope field is part of the contract on purpose — a DAEMON-side
// refusal reaches no surface yet, so the read must not be read as liveness.
const FIELDS = ['grantId', 'installationId', 'target', 'tools', 'writeMode', 'budget', 'effectiveAudience',
  'expiresAt', 'revokedAt', 'revokedBy', 'parentGrantId', 'rootGrantId', 'createdAt', 'grantedBy',
  'grantBrokerRefusal', 'grantBrokerRefusalScope'];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant');
  const grants = require('../../../routes/grants');
  app = express();
  app.use(express.json());
  app.use('/api/grants', grants);
  // Same order as server.ts: the grants list before the pod routes' catch-all.
  app.use('/api/pods', grants.podGrantsRouter);
  app.use('/api/pods', require('../../../routes/pods'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, type: 'team', members: [OWNER, MEMBER, SEAT, OTHER_SEAT] } : null) }),
  }));
  Integration.findById.mockResolvedValue(null);
  Integration.findOne.mockImplementation(async ({ installationId }) => (installationId === 'conn-1'
    ? { _id: 'conn-1', type: 'github-app', status: 'connected', createdBy: OWNER }
    : null));
  ToolCall.listForGrant.mockResolvedValue([]);
  ToolCall.countsForGrant.mockResolvedValue({ total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 });
});

describe('GET /api/pods/:podId/grants', () => {
  test('GET /api/pods/:podId/grants is reachable with the pod routes mounted', async () => {
    await RoomGrant.create(grant());
    const res = await request(app).get(`/api/pods/${POD}/grants`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.shadowed).toBeUndefined();
    expect(res.body.grants).toHaveLength(1);
  });

  test('the pod grants list refuses a non-member', async () => {
    await RoomGrant.create(grant());
    const stranger = await request(app).get(`/api/pods/${POD}/grants`).set('x-test-user', STRANGER);
    expect(stranger.status).toBe(403);
    expect(stranger.body.grants).toBeUndefined();
    const malformed = await request(app).get('/api/pods/not-an-id/grants').set('x-test-user', MEMBER);
    expect(malformed.status).toBe(403);
    const anon = await request(app).get(`/api/pods/${POD}/grants`);
    expect(anon.status).toBe(401);
  });

  test('a member sees the pod grants and the seat grants of seats in the pod, each in the field list', async () => {
    const podGrant = await RoomGrant.create(grant());
    const seatGrant = await RoomGrant.create(grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] }));
    await RoomGrant.create(grant({ target: { kind: 'seat', id: 'eeeeeeeeeeeeeeeeeeeeee01' }, audience: ['eeeeeeeeeeeeeeeeeeeeee01'] })); // a seat elsewhere
    await RoomGrant.create(grant({ target: { kind: 'pod', id: 'aaaaaaaaaaaaaaaaaaaaaa02' } })); // another pod
    const res = await request(app).get(`/api/pods/${POD}/grants`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.podId).toBe(POD);
    expect(res.body.grants.map((row) => row.grantId).sort()).toEqual([podGrant.grantId, seatGrant.grantId].sort());
    for (const row of res.body.grants) {
      expect(Object.keys(row).sort()).toEqual([...FIELDS].sort());
      expect(row.grantedBy).toBe(OWNER);
      expect(JSON.stringify(row)).not.toMatch(/conn-1|broker-1/);
    }
    const podRow = res.body.grants.find((row) => row.grantId === podGrant.grantId);
    // The raw snapshot names GONE; the page only ever sees the effective audience.
    expect(podRow.effectiveAudience).toEqual([SEAT]);
    expect(podRow.audience).toBeUndefined();
    const seatRow = res.body.grants.find((row) => row.grantId === seatGrant.grantId);
    expect(seatRow.effectiveAudience).toEqual([SEAT]);
  });
});

describe('GET /api/grants/:grantId/calls', () => {
  test('the trail refuses a non-member and never returns args', async () => {
    const row = await RoomGrant.create(grant());
    ToolCall.listForGrant.mockResolvedValue([trailRow({ grantId: row.grantId }), trailRow({ grantId: row.grantId, callId: 'call-2', outcome: 'refused', reason: 'not_in_audience' })]);
    ToolCall.countsForGrant.mockResolvedValue({ total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 });

    const stranger = await request(app).get(`/api/grants/${row.grantId}/calls`).set('x-test-user', STRANGER);
    expect(stranger.status).toBe(403);
    expect(stranger.body.calls).toBeUndefined();

    const member = await request(app).get(`/api/grants/${row.grantId}/calls`).set('x-test-user', MEMBER);
    expect(member.status).toBe(200);
    expect(member.body.counts).toEqual({ total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 });
    expect(member.body.calls).toHaveLength(2);
    for (const line of member.body.calls) {
      expect(line.argsDigest).toHaveLength(64);
      expect(line).not.toHaveProperty('args');
    }
    expect(JSON.stringify(member.body)).not.toContain('secret/private');
    expect(member.body.calls[1]).toMatchObject({ callId: 'call-2', outcome: 'refused', reason: 'not_in_audience', agentUserId: SEAT, tool: 'github.list_issues' });
    expect(ToolCall.listForGrant).toHaveBeenCalledWith(row.grantId, 100);

    // The seat the pod grant covers reads it too, on its runtime token.
    const seat = await request(app).get(`/api/grants/${row.grantId}/calls`).set('Authorization', 'Bearer cm_agent_x').set('x-test-agent', SEAT);
    expect(seat.status).toBe(200);
    const foreignAgent = await request(app).get(`/api/grants/${row.grantId}/calls`).set('Authorization', 'Bearer cm_agent_x').set('x-test-agent', 'eeeeeeeeeeeeeeeeeeeeee01');
    expect(foreignAgent.status).toBe(403);
  });

  test("a seat grant's trail is visible only to its granter and the seat", async () => {
    const row = await RoomGrant.create(grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] }));
    const read = (headers) => request(app).get(`/api/grants/${row.grantId}/calls`).set(headers);
    expect((await read({ 'x-test-user': OWNER })).status).toBe(200);
    expect((await read({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': SEAT })).status).toBe(200);
    // A pod member who is not the granter, and another seat in the same pod, both refused.
    expect((await read({ 'x-test-user': MEMBER })).status).toBe(403);
    expect((await read({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': OTHER_SEAT })).status).toBe(403);
    expect((await read({ 'x-test-user': STRANGER })).status).toBe(403);
    // Membership never substitutes for the granter check on a seat grant.
    const dm = require('../../../services/dmService');
    expect(dm.canViewPod).not.toHaveBeenCalled();
  });

  test('an unknown grant is 404 and the limit is clamped', async () => {
    expect((await request(app).get('/api/grants/grant_nope/calls').set('x-test-user', MEMBER)).status).toBe(404);
    const row = await RoomGrant.create(grant());
    await request(app).get(`/api/grants/${row.grantId}/calls?limit=9999`).set('x-test-user', MEMBER);
    expect(ToolCall.listForGrant).toHaveBeenLastCalledWith(row.grantId, 500);
  });
});

describe('GET /api/grants/:grantId', () => {
  test('GET /api/grants/:id returns the field list and never connectionId or brokerId', async () => {
    const row = await RoomGrant.create(grant({ parentGrantId: null, rootGrantId: 'grant_root' }));
    const res = await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...FIELDS].sort());
    expect(res.body).toMatchObject({
      grantId: row.grantId, installationId: 'install-1', target: { kind: 'pod', id: POD },
      tools: ['github.list_issues', 'github.comment'], writeMode: 'write-with-confirm',
      budget: { calls: 10, windowMs: 60000 }, effectiveAudience: [SEAT], revokedAt: null, revokedBy: null,
      parentGrantId: null, rootGrantId: 'grant_root', grantedBy: OWNER,
    });
    expect(res.body.connectionId).toBeUndefined();
    expect(res.body.brokerId).toBeUndefined();
    expect(res.body.audience).toBeUndefined();
    expect(res.body._id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/conn-1|broker-1|dddddddddddddddddddddd01/);
    // Still member-scoped, as before the tightening.
    expect((await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', STRANGER)).status).toBe(403);
  });

  test("a seat grant's read is gated like its trail: granter and seat only (Vera 67727)", async () => {
    const row = await RoomGrant.create(grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] }));
    const read = (headers) => request(app).get(`/api/grants/${row.grantId}`).set(headers);
    const owner = await read({ 'x-test-user': OWNER });
    expect(owner.status).toBe(200);
    expect(owner.body.grantedBy).toBe(OWNER);
    expect(owner.body.effectiveAudience).toEqual([SEAT]);
    expect((await read({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': SEAT })).status).toBe(200);
    // A stranger in no pod, a pod member who is not the granter, another seat: 403, tools and granter unseen.
    for (const headers of [{ 'x-test-user': STRANGER }, { 'x-test-user': MEMBER }, { Authorization: 'Bearer cm_agent_x', 'x-test-agent': OTHER_SEAT }]) {
      const res = await read(headers);
      expect(res.status).toBe(403);
      expect(res.body.tools).toBeUndefined();
      expect(res.body.grantedBy).toBeUndefined();
    }
  });
});

describe('POST /api/grants/:grantId/revoke', () => {
  test('records the authenticated caller as revokedBy', async () => {
    const row = await RoomGrant.create(grant());
    const res = await request(app).post(`/api/grants/${row.grantId}/revoke`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ grantId: row.grantId, revoked: 1 });

    const saved = await RoomGrant.findOne({ grantId: row.grantId }).lean();
    expect(saved.revokedAt).toBeInstanceOf(Date);
    expect(saved.revokedBy).toBe(OWNER);
  });
});

/**
 * TASK-063: the read has to say whether the BROKER is reaching the seat, and it
 * has to say it in the daemon's own terms. The refusal is computed by the same
 * projection `/assigned` builds its work list from, so these tests assert the
 * two surfaces agree rather than that this route re-implements the predicate.
 */
describe('GET /api/grants/:grantId — the seat confinement refusal (TASK-063)', () => {
  const AGENT = 'grantread-seat';
  let User; let AgentInstallation; let Machine;

  beforeAll(() => {
    User = require('../../../models/User');
    AgentInstallation = require('../../../models/AgentRegistry').AgentInstallation;
    Machine = require('../../../models/Machine');
  });

  /**
   * One seat identity, an installation declaring `adapter` + `sandbox`, and a
   * live seat-addressed grant. `machineId` (with `machineOwner`) is what the
   * daemon scope resolves through, so tests that omit it exercise the unbound
   * fallback: the identity's own active installations.
   */
  const seedSeatGrant = async ({
    adapter, sandbox, machineId = null, machineOwner = null, seatId = null, extraInstall = null,
  }) => {
    await Promise.all([User.deleteMany({}), AgentInstallation.deleteMany({}), Machine.deleteMany({})]);
    const tag = Math.random().toString(36).slice(2, 8);
    const installer = await User.create({
      username: `i${tag}`, email: `i${tag}@x.com`, password: 'x'.repeat(12),
    });
    const seat = await User.create({
      ...(seatId ? { _id: seatId } : {}),
      username: `s${tag}`, email: `s${tag}@agents.commonly.local`, password: 'x'.repeat(12), isBot: true,
      botMetadata: { agentName: AGENT, instanceId: 'default', ...(machineId ? { machineId } : {}) },
    });
    const environment = {
      version: 1,
      mcp: [{
        name: 'commonly', transport: 'stdio', command: ['npx', 'commonly-mcp'],
        env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
      }],
    };
    if (sandbox) environment.sandbox = sandbox;
    await AgentInstallation.create({
      agentName: AGENT, instanceId: 'default', podId: new mongoose.Types.ObjectId(),
      version: '1.0.0', status: 'active', installedBy: installer._id,
      config: { runtime: { runtimeType: 'wrapper', adapter }, environment },
    });
    if (extraInstall) {
      await AgentInstallation.create({
        agentName: AGENT, instanceId: 'default', podId: new mongoose.Types.ObjectId(),
        version: '1.0.0', status: 'active', installedBy: extraInstall.installedBy,
        config: {
          runtime: { runtimeType: 'wrapper', adapter: extraInstall.adapter },
          environment: {
            version: 1,
            ...(extraInstall.sandbox ? { sandbox: extraInstall.sandbox } : {}),
          },
        },
      });
    }
    if (machineId) await Machine.create({ ownerUserId: machineOwner || installer._id, machineId, name: 'Mac' });
    const row = await RoomGrant.create(grant({ target: { kind: 'seat', id: String(seat._id) }, audience: [String(seat._id)] }));
    return { row, seat, installer };
  };

  test('a pi seat reads as refused, and the refusal names the layer that decided', async () => {
    // The environment declares NO sandbox and no broker entry: the grant is the
    // source of the broker, and the adapter is what no host can confine.
    const { row } = await seedSeatGrant({ adapter: 'pi' });
    const res = await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.grantBrokerRefusal).toMatchObject({
      code: 'grant_broker_unconfined', decidedBy: 'server', reason: 'adapter_cannot_confine',
    });
    expect(res.body.grantBrokerRefusal.detail).toMatch(/adapter/i);
    expect(res.body.grantBrokerRefusalScope).toBe('server');
  });

  test('a declaration a host can confine reads as no refusal', async () => {
    const { row } = await seedSeatGrant({
      adapter: 'claude', sandbox: { mode: 'workspace', trust: 'public' },
    });
    const res = await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.grantBrokerRefusal).toBeNull();
    // The scope field is present either way: "no refusal" and "we did not look"
    // must not be the same response.
    expect(res.body.grantBrokerRefusalScope).toBe('server');
  });

  test('a mode no adapter enforces reads as refused, and an absent declaration does not', async () => {
    const unenforceable = await seedSeatGrant({ adapter: 'claude', sandbox: { mode: 'none', trust: 'public' } });
    const refused = await request(app).get(`/api/grants/${unenforceable.row.grantId}`).set('x-test-user', OWNER);
    expect(refused.body.grantBrokerRefusal.reason).toBe('sandbox_mode_none');

    // CONTROL: the shape 29 of 30 local records have — the ordinary stdio
    // `commonly` entry, no sandbox block, a confining adapter. Refusing here
    // would refuse the working path, and the daemon is the layer that decides it.
    const plain = await seedSeatGrant({ adapter: 'claude' });
    const allowed = await request(app).get(`/api/grants/${plain.row.grantId}`).set('x-test-user', OWNER);
    expect(allowed.body.grantBrokerRefusal).toBeNull();
  });

  test("the scope is the seat's machine owner, so the read agrees with the daemon it feeds", async () => {
    // Two active installations of the SAME identity, disagreeing: the
    // installing user's is pi (unconfinable), a second user's is a confining
    // claude declaration. `/assigned` builds its list from the machine OWNER's
    // installations, so the read has to resolve the same scope — an
    // identity-wide scan would report whichever row was stored first.
    const { row, installer } = await seedSeatGrant({ adapter: 'pi', machineId: 'machine-scope' });
    const otherOwner = await User.create({
      username: `m${Math.random().toString(36).slice(2, 8)}`, email: 'm@x.com', password: 'x'.repeat(12),
    });
    await AgentInstallation.create({
      agentName: AGENT, instanceId: 'default', podId: new mongoose.Types.ObjectId(),
      version: '1.0.0', status: 'active', installedBy: otherOwner._id,
      config: {
        runtime: { runtimeType: 'wrapper', adapter: 'claude' },
        environment: { version: 1, sandbox: { mode: 'workspace', trust: 'public' } },
      },
    });
    // The seat's machine now belongs to the second user, whose declaration is
    // the confining one.
    await Machine.updateOne({ machineId: 'machine-scope' }, { $set: { ownerUserId: otherOwner._id } });
    const read = () => request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', OWNER);

    // The machine owner's declaration confines, so nothing is withheld — even
    // though the identity's OTHER installation is a pi seat.
    expect((await read()).body.grantBrokerRefusal).toBeNull();

    // CONTROL: re-home the seat onto the pi installer and the same request
    // reports the refusal, which is what makes the assertion above about SCOPE
    // rather than about the pi install being missing.
    await Machine.updateOne({ machineId: 'machine-scope' }, { $set: { ownerUserId: installer._id } });
    expect((await read()).body.grantBrokerRefusal.reason).toBe('adapter_cannot_confine');
  });

  test('the pod grant list carries the same refusal, from the same projection', async () => {
    // Seated at MEMBER so the mocked pod census contains the seat and the list
    // route returns it.
    const { row } = await seedSeatGrant({ adapter: 'pi', seatId: new mongoose.Types.ObjectId(MEMBER) });
    const res = await request(app).get(`/api/pods/${POD}/grants`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    const listed = res.body.grants.find((entry) => entry.grantId === row.grantId);
    expect(listed.grantBrokerRefusal).toMatchObject({ reason: 'adapter_cannot_confine' });
    expect(listed.grantBrokerRefusalScope).toBe('server');
  });

  test('a pod-addressed grant is not judged: the predicate is about a seat', async () => {
    const row = await RoomGrant.create(grant());
    const res = await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.grantBrokerRefusal).toBeNull();
  });
});
