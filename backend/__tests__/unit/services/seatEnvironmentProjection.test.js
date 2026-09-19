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
    expect([...mine.keys()]).toEqual(['proj-seat\0default']);
    expect(mine.get('proj-seat\0default').podIds.map(String).sort())
      .toEqual([String(podOne), String(podTwo)].sort());
    // First declaration wins for the runtime, exactly as the daemon list has
    // always resolved a duplicated identity — no new ordering rule here.
    expect(mine.get('proj-seat\0default').runtime).toEqual({ adapter: 'claude' });

    const theirs = await projectSeatEnvironments({ installedBy: b._id });
    expect(theirs.get('proj-seat\0default').runtime).toEqual({ adapter: 'pi' });
  });

  test('matches a stored instanceId case-insensitively, because the schema lowercases only agentName', async () => {
    const a = await owner('c');
    await install(a._id, { agentName: 'Proj-Seat', instanceId: 'Quill' });
    const found = await projectSeatEnvironments({ installedBy: a._id, agentNames: ['proj-seat'], instanceId: 'quill' });
    expect([...found.keys()]).toEqual(['proj-seat\0quill']);
    expect(await projectSeatEnvironments({ agentNames: ['proj-seat'], instanceId: 'other' })).toEqual(new Map());
    // The row itself is stored lowercased for agentName and untouched for
    // instanceId — the shape the normalisation above exists to absorb.
    const stored = await AgentInstallation.findOne({}).lean();
    expect(stored.agentName).toBe('proj-seat');
    expect(stored.instanceId).toBe('Quill');
  });

  test('an empty identity scope yields nothing rather than the whole collection', async () => {
    const a = await owner('d');
    await install(a._id);
    expect(await projectSeatEnvironments({ agentNames: [] })).toEqual(new Map());
    expect(await projectSeatEnvironments({ agentNames: ['   '] })).toEqual(new Map());
    // An unscoped call is the daemon-wide projection, and it is the caller's
    // explicit choice — the write path always passes one of the two scopes.
    expect((await projectSeatEnvironments({})).size).toBe(1);
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
    const entry = (await projectSeatEnvironments({ installedBy: a._id })).get('proj-seat\0default');
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
