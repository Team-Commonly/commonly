/**
 * F150: a seat run with `commonly agent run` (no daemon) reads its live grant
 * brokers from GET /api/agents/runtime/grant-brokers, authenticated by its own
 * runtime token. The projection is the one /assigned computes per seat
 * (`grantServersForIdentities`), so the run path and the daemon path cannot
 * disagree about which grants a seat has or which refusals apply.
 *
 * Real mongod (MongoMemoryServer) and the real agentRuntimeAuth middleware: the
 * identity filter is the token's own bot User, and nothing in the request can
 * name another one.
 */
process.env.PG_HOST = '';

const express = require('express');
const request = require('supertest');

const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const { hash } = require('../../utils/secret');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { GRANT_BROKER_REFUSAL_CODE } = require('../../services/grantBrokerConfinement');

const model = (m) => m.default || m;
const User = model(require('../../models/User'));
const Pod = model(require('../../models/Pod'));
const RoomGrant = model(require('../../models/RoomGrant'));
const { AgentInstallation } = require('../../models/AgentRegistry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

jest.setTimeout(60000);

const SEAT_TOKEN = `cm_agent_${'s'.repeat(40)}`;
const OTHER_TOKEN = `cm_agent_${'o'.repeat(40)}`;

let app;
let seq = 0;

const brokerUrl = (grantId) => `\${COMMONLY_API_URL}/api/mcp/grants/${encodeURIComponent(grantId)}`;

const makeUser = (extra = {}) => {
  seq += 1;
  return User.create({
    username: `u${seq}${Date.now() % 1e5}`, email: `u${seq}${Date.now()}@x.com`, password: 'x'.repeat(12), ...extra,
  });
};

const makeBot = (agentName, token) => makeUser({
  isBot: true,
  botType: 'agent',
  botMetadata: { agentName, instanceId: 'default' },
  agentRuntimeTokens: [{ tokenHash: hash(token), label: 'test', createdAt: new Date() }],
});

/**
 * Two seats, one owner, one pod. `seatEnvironment` is what the owner's
 * installation declares for `quill` (the seat under test); `runtime` its runtime.
 */
const seed = async ({
  seatEnvironment = null,
  runtime = { runtimeType: 'webhook' },
} = {}) => {
  const owner = await makeUser();
  const seat = await makeBot('quill', SEAT_TOKEN);
  const other = await makeBot('wren', OTHER_TOKEN);
  const pod = await Pod.create({
    name: `p${seq}`, createdBy: owner._id, members: [owner._id, seat._id, other._id],
  });
  const config = { runtime, ...(seatEnvironment ? { environment: seatEnvironment } : {}) };
  await AgentInstallation.create({
    agentName: 'quill',
    instanceId: 'default',
    podId: pod._id,
    version: '1.0.0',
    status: 'active',
    installedBy: owner._id,
    config,
  });
  await AgentInstallation.create({
    agentName: 'wren',
    instanceId: 'default',
    podId: pod._id,
    version: '1.0.0',
    status: 'active',
    installedBy: owner._id,
    config: { runtime: { runtimeType: 'webhook' } },
  });
  return {
    owner, seat, other, pod, 
  };
};

const grantFor = (fields) => RoomGrant.create({
  connectionId: 'conn-test',
  installationId: 'gh-install-1',
  brokerId: GRANT_BROKER_ID,
  tools: ['read_file'],
  writeMode: 'read',
  budget: { calls: 10, windowMs: 60000 },
  expiresAt: new Date(Date.now() + 3600000),
  revokedAt: null,
  ...fields,
});

/** F94: the grant names `seat`, with a consent that recorded no sandbox. */
const namedGrant = async ({
  owner, seat, grantId = 'grant_named', sandbox = 'unknown', 
}) => grantFor({
  grantId,
  target: { kind: 'seat', id: String(seat._id) },
  audience: [String(seat._id)],
  ownerId: owner._id,
  byoAgents: [String(seat._id)],
  byoConsent: {
    by: owner._id,
    at: new Date(),
    version: 'byo-v1',
    agents: [{ userId: String(seat._id), sandbox }],
  },
});

const read = (token, adapter = 'claude') => request(app)
  .get('/api/agents/runtime/grant-brokers')
  .query(adapter === null ? {} : { adapter })
  .set('Authorization', `Bearer ${token}`);

const brokerNames = (body) => (body.servers || []).map((server) => server.name);

describe('GET /api/agents/runtime/grant-brokers (F150)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', agentsRuntimeRoutes);
  });
  afterEach(clearMongoDb);
  afterAll(closeMongoDb);

  test('a grant that names the seat reaches that seat, flagged as named', async () => {
    const fixture = await seed();
    await namedGrant(fixture);
    const res = await read(SEAT_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.refusal).toBeNull();
    expect(res.body.servers).toEqual([expect.objectContaining({
      name: GRANT_BROKER_ID,
      transport: 'http',
      url: brokerUrl('grant_named'),
      // eslint-disable-next-line no-template-curly-in-string -- the placeholder the seat expands
      headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
      byoNamed: true,
    })]);
  });

  test('another seat reads nothing from a grant that named this one', async () => {
    const fixture = await seed();
    await namedGrant(fixture);
    const res = await read(OTHER_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ servers: [], refusal: null });
  });

  test('a seat outside a pod grant\'s pod reads nothing from it', async () => {
    const fixture = await seed();
    // A pod grant for a pod the seat is not installed in nor a member of.
    const elsewhere = await Pod.create({ name: 'elsewhere', createdBy: fixture.owner._id, members: [fixture.owner._id] });
    await grantFor({
      grantId: 'grant_elsewhere',
      target: { kind: 'pod', id: String(elsewhere._id) },
      audience: [String(fixture.seat._id)],
    });
    const res = await read(SEAT_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ servers: [], refusal: null });
  });

  test('an unnamed pod grant in the seat\'s own pod arrives unflagged', async () => {
    const fixture = await seed({ seatEnvironment: { sandbox: { mode: 'workspace', trust: 'public' } } });
    await grantFor({
      grantId: 'grant_pod',
      target: { kind: 'pod', id: String(fixture.pod._id) },
      audience: [String(fixture.seat._id), String(fixture.other._id)],
    });
    const res = await read(SEAT_TOKEN);
    expect(res.status).toBe(200);
    expect(brokerNames(res.body)).toEqual([GRANT_BROKER_ID]);
    expect(res.body.servers[0].byoNamed).toBeUndefined();
  });

  test('a caller declaring an adapter that cannot confine gets a refusal and no broker, named or not', async () => {
    const fixture = await seed();
    await namedGrant(fixture);
    const responses = await Promise.all(['pi', 'goose', 'qwen', 'opencode'].map((adapter) => read(SEAT_TOKEN, adapter)));
    responses.forEach((res) => {
      expect(res.status).toBe(200);
      expect(res.body.servers).toEqual([]);
      expect(res.body.refusal).toMatchObject({
        code: GRANT_BROKER_REFUSAL_CODE, decidedBy: 'server', reason: 'adapter_cannot_confine',
      });
    });
  });

  test('the installation\'s own unproven adapter still refuses when the caller claims claude', async () => {
    const fixture = await seed({ runtime: { runtimeType: 'wrapper', adapter: 'pi' } });
    await namedGrant(fixture);
    const res = await read(SEAT_TOKEN, 'claude');
    expect(res.body.servers).toEqual([]);
    expect(res.body.refusal).toMatchObject({ reason: 'adapter_cannot_confine' });
  });

  test('a declared sandbox no host confines is lifted only by naming', async () => {
    const fixture = await seed({ seatEnvironment: { sandbox: { mode: 'none', trust: 'public' } } });
    await grantFor({
      grantId: 'grant_unnamed',
      target: { kind: 'seat', id: String(fixture.seat._id) },
      audience: [String(fixture.seat._id)],
    });
    const refused = await read(SEAT_TOKEN);
    expect(refused.body.servers).toEqual([]);
    expect(refused.body.refusal).toMatchObject({ reason: 'sandbox_mode_none' });

    await RoomGrant.deleteMany({});
    await namedGrant(fixture);
    const named = await read(SEAT_TOKEN);
    expect(named.body.refusal).toBeNull();
    expect(named.body.servers).toEqual([expect.objectContaining({ byoNamed: true })]);
  });

  // F150 security review (HIGH): with no daemon, an absent sandbox block
  // confines nothing, so the server withholds an unnamed grant itself rather
  // than leaving it to the seat's own guard (anyone with the token can call this).
  test('an unnamed grant on a seat with no sandbox block is withheld, with a refusal', async () => {
    const fixture = await seed();
    await grantFor({
      grantId: 'grant_pod_unnamed',
      target: { kind: 'pod', id: String(fixture.pod._id) },
      audience: [String(fixture.seat._id), String(fixture.other._id)],
    });
    const res = await read(SEAT_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual([]);
    expect(res.body.refusal).toMatchObject({
      code: GRANT_BROKER_REFUSAL_CODE, decidedBy: 'server', reason: 'sandbox_absent',
    });
  });

  test('a named grant on a seat with no sandbox block still arrives flagged, beside a withheld unnamed one', async () => {
    const fixture = await seed();
    await namedGrant(fixture);
    await grantFor({
      grantId: 'grant_pod_unnamed',
      target: { kind: 'pod', id: String(fixture.pod._id) },
      audience: [String(fixture.seat._id), String(fixture.other._id)],
    });
    const res = await read(SEAT_TOKEN);
    expect(res.body.servers).toEqual([expect.objectContaining({ url: brokerUrl('grant_named'), byoNamed: true })]);
    // The unnamed sibling was withheld, so the refusal is reported for it.
    expect(res.body.refusal).toMatchObject({ reason: 'sandbox_absent' });
  });

  test('a runtime Commonly runs keeps the old reading: an unnamed grant with no sandbox block arrives', async () => {
    const fixture = await seed({ runtime: { runtimeType: 'native' } });
    await grantFor({
      grantId: 'grant_pod_native',
      target: { kind: 'pod', id: String(fixture.pod._id) },
      audience: [String(fixture.seat._id)],
    });
    const res = await read(SEAT_TOKEN);
    expect(res.body.refusal).toBeNull();
    expect(res.body.servers).toEqual([expect.objectContaining({ url: brokerUrl('grant_pod_native') })]);
  });

  // CodeRabbit (#3458): the row declares a confining sandbox, so the server
  // raises no refusal, but the standalone CLI's local record may declare none
  // and its own guard would then drop the entry. A grant that names the seat
  // must say so on the entry whether or not the server refused.
  test('a named grant on a row the server judges confinable still arrives flagged', async () => {
    const fixture = await seed({ seatEnvironment: { sandbox: { mode: 'workspace', trust: 'public' } } });
    await namedGrant(fixture);
    const res = await read(SEAT_TOKEN);
    expect(res.body.refusal).toBeNull();
    expect(res.body.servers).toEqual([expect.objectContaining({ url: brokerUrl('grant_named'), byoNamed: true })]);
  });

  test('revoking the grant drops it from the next read', async () => {
    const fixture = await seed();
    await namedGrant(fixture);
    expect(brokerNames((await read(SEAT_TOKEN)).body)).toEqual([GRANT_BROKER_ID]);
    await RoomGrant.updateOne({ grantId: 'grant_named' }, { $set: { revokedAt: new Date() } });
    expect((await read(SEAT_TOKEN)).body).toEqual({ servers: [], refusal: null });
  });

  test('a caller must declare its adapter', async () => {
    await seed();
    const res = await read(SEAT_TOKEN, null);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('adapter_required');
  });

  test('no token, no read', async () => {
    const res = await request(app).get('/api/agents/runtime/grant-brokers').query({ adapter: 'claude' });
    expect(res.status).toBe(401);
  });
});
