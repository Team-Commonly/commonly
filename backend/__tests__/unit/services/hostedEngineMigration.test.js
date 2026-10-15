/**
 * TASK-265: moving hosted installs from the Durable Object onto the native
 * engine. Real installation, event and user models on an in-memory Mongo; the
 * worker call, the token revoke and the in-process dispatcher are mocked.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const mockDeprovision = jest.fn();
jest.mock('../../../services/hostedRuntimeService', () => ({
  ...jest.requireActual('../../../services/hostedRuntimeService'),
  isConfigured: () => true,
  deprovisionAgent: (...args) => mockDeprovision(...args),
}));
const mockRevoke = jest.fn();
jest.mock('../../../routes/registry/tokens', () => ({
  revokeRuntimeTokensForAgent: (...args) => mockRevoke(...args),
}));
const mockDispatch = jest.fn();
jest.mock('../../../services/agentEventService', () => ({
  dispatchInProcess: (...args) => mockDispatch(...args),
}));

let mongod; let AgentInstallation; let AgentEvent; let User; let migrate;
const NOW = new Date('2026-10-15T17:00:00Z');
const OWNER = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  ({ AgentInstallation } = require('../../../models/AgentRegistry'));
  AgentEvent = require('../../../models/AgentEvent');
  User = require('../../../models/User');
  ({ migrateHostedInstallsToNative: migrate } = require('../../../services/hostedEngineMigration'));
});

afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const install = (agentName, podId, hosted) => AgentInstallation.create({
  agentName,
  instanceId: 'default',
  podId,
  version: '1.0.0',
  status: 'active',
  installedBy: OWNER,
  config: { runtime: { runtimeType: 'hosted' }, ...(hosted ? { hosted } : {}) },
});

const hostedOf = async (id) => {
  const row = await AgentInstallation.findById(id).lean();
  return row.config.hosted;
};

let podA; let podB; let maya; let mayaB; let idle; let already;
beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([AgentInstallation.deleteMany({}), AgentEvent.deleteMany({}), User.deleteMany({})]);
  mockDeprovision.mockResolvedValue(true);
  mockRevoke.mockResolvedValue(['hash-1']);
  podA = new mongoose.Types.ObjectId();
  podB = new mongoose.Types.ObjectId();
  // One identity installed in two pods, a stopped one, and one already native.
  maya = await install('maya-agent', podA, { provisionedAt: new Date('2026-10-01') });
  mayaB = await install('maya-agent', podB, { provisionedAt: new Date('2026-10-02') });
  idle = await install('idle-agent', podA, { provisionedAt: null, deprovisionedAt: new Date('2026-10-03') });
  already = await install('native-agent', podA, { engine: 'native', provisionedAt: new Date('2026-10-04') });
  await User.create({
    username: 'maya-agent',
    email: 'maya-agent@agents.commonly.local',
    password: 'x'.repeat(12),
    isBot: true,
    botMetadata: { agentName: 'maya-agent', instanceId: 'default', description: '  Keeps   the research log.  ' },
  });
});

test('a dry run reports per identity and changes nothing', async () => {
  const report = await migrate({ apply: false, now: NOW });

  expect(report.dryRun).toBe(true);
  expect(report.identities.map((entry) => [entry.agentName, entry.installs, entry.provisioned]).sort())
    .toEqual([['idle-agent', 1, false], ['maya-agent', 2, true]]);
  expect(mockDeprovision).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect((await hostedOf(maya._id)).engine).toBeUndefined();
});

test('apply stops the Durable Object, revokes tokens and marks every install of the identity native', async () => {
  const report = await migrate({ apply: true, now: NOW });

  const entry = report.identities.find((row) => row.agentName === 'maya-agent');
  expect(entry).toMatchObject({ durableObjectStopped: true, tokensRevoked: 1 });
  expect(mockDeprovision).toHaveBeenCalledWith('maya-agent', 'default');
  for (const id of [maya._id, mayaB._id]) {
    // eslint-disable-next-line no-await-in-loop
    expect(await hostedOf(id)).toEqual(expect.objectContaining({
      engine: 'native', provisionedAt: NOW, about: 'Keeps the research log.', migratedFrom: 'durable-object',
    }));
  }
});

test('a stopped install stays stopped, gets no worker call, and an already-native one is untouched', async () => {
  await migrate({ apply: true, now: NOW });

  expect(await hostedOf(idle._id)).toEqual(expect.objectContaining({ engine: 'native', provisionedAt: null }));
  expect(mockDeprovision).not.toHaveBeenCalledWith('idle-agent', 'default');
  const untouched = await hostedOf(already._id);
  expect(untouched.migratedFrom).toBeUndefined();
});

test('a recent pending event runs in-process; a stale one is closed with a reason', async () => {
  const [recent, stale] = await AgentEvent.create([
    { agentName: 'maya-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending', createdAt: new Date(NOW.getTime() - 60 * 1000) },
    { agentName: 'maya-agent', instanceId: 'default', podId: podB, type: 'chat.mention', payload: {}, status: 'pending', createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
  ]);

  const report = await migrate({ apply: true, now: NOW });

  expect(report.identities.find((row) => row.agentName === 'maya-agent')).toMatchObject({ pendingRun: 1, pendingClosed: 1 });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(String(mockDispatch.mock.calls[0][0]._id)).toBe(String(recent._id));
  expect((await AgentEvent.findById(recent._id).lean()).status).toBe('delivered');
  const closed = await AgentEvent.findById(stale._id).lean();
  expect(closed.status).toBe('failed');
  expect(closed.error).toMatch(/hosted engine migrated/);
});

test('one identity failing is reported and does not stop the others', async () => {
  mockDeprovision.mockRejectedValueOnce(new Error('worker down'));

  const report = await migrate({ apply: true, now: NOW });

  expect(report.identities.find((row) => row.agentName === 'maya-agent').error).toBe('worker down');
  expect((await hostedOf(maya._id)).engine).toBeUndefined();
  expect((await hostedOf(idle._id)).engine).toBe('native');
});
