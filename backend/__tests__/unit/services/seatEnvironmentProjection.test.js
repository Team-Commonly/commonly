/**
 * The extracted identity → environment projection (TASK-063).
 *
 * This module is the ONE definition of what a seat receives: the daemon's work
 * list is built from it and the grant read now answers from it, so a silent
 * change here reaches both surfaces at once. The tests below pin the parts a
 * refactor can break without any route turning red: the composite key, the
 * identity normalisation, the owner scope, first-declaration-wins, and the
 * placeholder-only env allow-list that keeps the daemon-token boundary.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const {
  projectSeatEnvironments,
  seatEnvironmentKey,
  normalizeIdentityPart,
} = require('../../../services/seatEnvironmentProjection');

let mongod;
let User;
let AgentInstallation;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  User = require('../../../models/User');
  AgentInstallation = require('../../../models/AgentRegistry').AgentInstallation;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const owner = async (tag) => User.create({
  username: `o-${tag}`, email: `o-${tag}@x.com`, password: 'x'.repeat(12),
});

const install = async (installedBy, over = {}) => AgentInstallation.create({
  agentName: 'proj-seat',
  instanceId: 'default',
  podId: new mongoose.Types.ObjectId(),
  version: '1.0.0',
  status: 'active',
  installedBy,
  config: {},
  ...over,
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AgentInstallation.deleteMany({})]);
});

describe('the identity key', () => {
  test('is composed with a NUL separator and normalises both parts', () => {
    // The separator is the contract with the daemon list's lookup: a route
    // builds keys with it in one place and reads them with it in another, and
    // a space instead of a NUL silently returns nothing rather than erroring.
    expect(seatEnvironmentKey('Proj-Seat', 'Quill')).toBe('proj-seat\0quill');
    expect(seatEnvironmentKey(' proj-seat ', ' Quill ')).toBe('proj-seat\0quill');
    expect(seatEnvironmentKey('proj-seat', undefined)).toBe('proj-seat\0default');
    expect(seatEnvironmentKey('proj-seat', '')).toBe('proj-seat\0default');
    expect(normalizeIdentityPart(null)).toBe('');
  });
});

describe('projectSeatEnvironments', () => {
  test('scopes to the owner, keys by identity, and unions the pods', async () => {
    const [a, b] = [await owner('a'), await owner('b')];
    const podOne = new mongoose.Types.ObjectId();
    const podTwo = new mongoose.Types.ObjectId();
    await install(a._id, { podId: podOne, config: { runtime: { adapter: 'claude' } } });
    await install(a._id, { podId: podTwo });
    await install(b._id, { config: { runtime: { adapter: 'pi' } } });

    const mine = await projectSeatEnvironments({ installedBy: a._id });
    expect([...mine.keys()]).toEqual([seatEnvironmentKey('proj-seat', 'default')]);
    const entry = mine.get(seatEnvironmentKey('proj-seat', 'default'));
    expect(entry.podIds.map(String).sort()).toEqual([String(podOne), String(podTwo)].sort());
    // The pair comes from the OLDEST active declaration (`_id` ascending),
    // which for a duplicated identity is a rule rather than the stored order.
    expect(entry.runtime).toEqual({ adapter: 'claude' });

    const theirs = await projectSeatEnvironments({ installedBy: b._id });
    expect(theirs.get(seatEnvironmentKey('proj-seat', 'default')).runtime).toEqual({ adapter: 'pi' });
  });

  test('an empty declaration cannot shadow a newer row that delivers', async () => {
    // The predicate is the raw key, so a row whose environment the allow-list
    // reduces to NOTHING still counts as the source and the newer row's real
    // environment is never read. "Declares" has to mean "delivers" for the
    // oldest-wins rule to pick the row that actually describes the seat.
    const a = await owner('empty');
    const silent = await install(a._id, {
      config: { environment: { not_a_declared_field: 'dropped by the allow-list' } },
    });
    const real = await install(a._id, {
      config: { environment: { version: 1, model: 'the-real-model' } },
    });
    // The fixture is what the test assumes: the silent row is the older one.
    expect(String(silent._id) < String(real._id)).toBe(true);
    const entry = (await projectSeatEnvironments({ installedBy: a._id }))
      .get(seatEnvironmentKey('proj-seat', 'default'));
    expect(entry.environment).toEqual({ version: 1, model: 'the-real-model' });
    expect(JSON.stringify(entry)).not.toContain('not_a_declared_field');
    // podIds is the union either way: skipping a row as a SOURCE does not
    // remove it from the identity's placements.
    expect(entry.podIds).toEqual(expect.arrayContaining([String(silent.podId), String(real.podId)]));
  });

  test('an unscoped call projects every owner, and a scoped one never leaks another owner\'s seat', async () => {
    const [a, b] = [await owner('b1'), await owner('b2')];
    await install(a._id, { agentName: 'only-a' });
    await install(b._id, { agentName: 'only-b' });
    const all = await projectSeatEnvironments();
    expect([...all.keys()].sort()).toEqual([
      seatEnvironmentKey('only-a', 'default'), seatEnvironmentKey('only-b', 'default'),
    ].sort());
    expect([...(await projectSeatEnvironments({ installedBy: a._id })).keys()])
      .toEqual([seatEnvironmentKey('only-a', 'default')]);
  });

  test('a stored instanceId is found through the shared key, which the schema does not lowercase', async () => {
    // AgentInstallationSchema lowercases agentName but NOT instanceId, so the
    // seat stored as `Quill` is only findable because the key normalises both
    // sides. A raw template string would miss it and the read would silently
    // fall through to "nothing withheld".
    const a = await owner('c');
    await install(a._id, { agentName: 'Proj-Seat', instanceId: 'Quill' });
    const projected = await projectSeatEnvironments({ installedBy: a._id });
    expect(projected.get(seatEnvironmentKey('proj-seat', 'quill'))).toBeDefined();
    expect(projected.get(seatEnvironmentKey('PROJ-SEAT', 'quill'))).toBeDefined();
    expect(projected.get(seatEnvironmentKey('proj-seat', 'other'))).toBeUndefined();
    const stored = await AgentInstallation.findOne({}).lean();
    expect(stored.agentName).toBe('proj-seat');
    expect(stored.instanceId).toBe('Quill');
  });

  test('projects the environment through the placeholder allow-list', async () => {
    const a = await owner('e');
    await install(a._id, {
      config: {
        runtime: { adapter: 'claude' },
        environment: {
          version: 1,
          model: 'claude-opus-5',
          sandbox: { mode: 'workspace', trust: 'internal', network: { policy: 'restricted' } },
          mcp: [{
            name: 'commonly',
            transport: 'stdio',
            command: ['npx', 'commonly-mcp'],
            env: {
              COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
              LITERAL_SECRET: 'ghp_shipped_to_every_daemon',
            },
            headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}', 'X-Other': 'literal' },
          }],
        },
      },
    });
    const entry = (await projectSeatEnvironments({ installedBy: a._id }))
      .get(seatEnvironmentKey('proj-seat', 'default'));
    expect(entry.environment.sandbox).toEqual({
      mode: 'workspace', trust: 'internal', network: { policy: 'restricted' },
    });
    expect(entry.environment.mcp[0].env).toEqual({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' });
    // A header that is not the broker's own projection is dropped, and the
    // literal value never reaches the daemon-token boundary.
    expect(entry.environment.mcp[0].headers).toEqual({ Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' });
    expect(JSON.stringify(entry)).not.toMatch(/ghp_|X-Other/);
  });
});
