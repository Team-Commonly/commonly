/**
 * TASK-265: moving hosted installs from the Durable Object onto the native
 * engine. Real installation, event and user models on an in-memory Mongo; the
 * worker calls and the token revoke are mocked. Each arm below is one of the
 * findings in Rhea's and sprint-review's HOLDs on #2236.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mockConfigured = true;
const mockDeprovision = jest.fn();
jest.mock('../../../services/hostedRuntimeService', () => ({
  ...jest.requireActual('../../../services/hostedRuntimeService'),
  isConfigured: () => mockConfigured,
  deprovisionAgent: (...args) => mockDeprovision(...args),
}));
const mockRevoke = jest.fn();
jest.mock('../../../routes/registry/tokens', () => ({
  revokeRuntimeTokensForAgent: (...args) => mockRevoke(...args),
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
const hostedOf = async (id) => (await AgentInstallation.findById(id).lean()).config.hosted;
const engines = async (ids) => Promise.all(ids.map(async (id) => (await hostedOf(id))?.engine));
const entryFor = (report, name) => report.identities.find((row) => row.agentName === name);

let podA; let podB; let maya; let mayaB; let idle; let born;
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockConfigured = true;
  await Promise.all([AgentInstallation.deleteMany({}), AgentEvent.deleteMany({}), User.deleteMany({})]);
  mockDeprovision.mockResolvedValue(true);
  mockRevoke.mockResolvedValue(['hash-1']);
  podA = new mongoose.Types.ObjectId();
  podB = new mongoose.Types.ObjectId();
  maya = await install('maya-agent', podA, { provisionedAt: new Date('2026-10-01') });
  mayaB = await install('maya-agent', podB, { provisionedAt: new Date('2026-10-02') });
  idle = await install('idle-agent', podA, { provisionedAt: null, deprovisionedAt: new Date('2026-10-03') });
  born = await install('native-agent', podA, { engine: 'native', provisionedAt: new Date('2026-10-04') });
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
  expect(report.identities.map((row) => [row.agentName, row.installs, row.provisioned]).sort())
    .toEqual([['idle-agent', 1, false], ['maya-agent', 2, true]]);
  expect(mockDeprovision).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(await engines([maya._id, mayaB._id, idle._id])).toEqual([undefined, undefined, undefined]);
});

test('rows are native BEFORE the revoke, so no token can be minted in between (Rhea 1)', async () => {
  let enginesAtRevoke;
  mockRevoke.mockImplementation(async () => {
    enginesAtRevoke = await engines([maya._id, mayaB._id]);
    return ['hash-1'];
  });

  const report = await migrate({ apply: true, now: NOW });

  expect(enginesAtRevoke).toEqual(['native', 'native']);
  expect(entryFor(report, 'maya-agent')).toMatchObject({ durableObjectStopped: true, tokensRevoked: 1 });
  expect(await hostedOf(maya._id)).toEqual(expect.objectContaining({
    engine: 'native', provisionedAt: NOW, about: 'Keeps the research log.', migratedFrom: 'durable-object',
  }));
});

test('a row that fails to save restores the others; the worker and the tokens are untouched (Rhea 2)', async () => {
  // Fail exactly the second row's native mark, after the first row of the
  // same identity is already native, so the restore has real work to do.
  const original = AgentInstallation.updateOne.bind(AgentInstallation);
  jest.spyOn(AgentInstallation, 'updateOne').mockImplementation((filter, update, ...rest) => {
    const marking = update?.$set?.['config.hosted']?.engine === 'native';
    if (marking && String(filter?._id) === String(mayaB._id)) return Promise.reject(new Error('write failed'));
    return original(filter, update, ...rest);
  });

  const report = await migrate({ apply: true, now: NOW });

  expect(entryFor(report, 'maya-agent').error).toMatch(/restored, nothing changed/);
  expect(await engines([maya._id, mayaB._id])).toEqual([undefined, undefined]);
  expect((await hostedOf(maya._id)).provisionedAt).toEqual(new Date('2026-10-01'));
  expect(mockDeprovision).not.toHaveBeenCalledWith('maya-agent', 'default');
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('a Durable Object that will not stop restores every row (Rhea 2)', async () => {
  mockDeprovision.mockRejectedValueOnce(new Error('worker down'));

  const report = await migrate({ apply: true, now: NOW });

  expect(entryFor(report, 'maya-agent').error).toMatch(/did not stop .*restored/);
  expect(await engines([maya._id, mayaB._id])).toEqual([undefined, undefined]);
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('a failed revoke is reported, and the next run finishes it (Rhea 2)', async () => {
  mockRevoke.mockRejectedValueOnce(new Error('db down'));
  const first = await migrate({ apply: true, now: NOW });
  expect(entryFor(first, 'maya-agent').error).toMatch(/run again to finish/);
  expect(await engines([maya._id, mayaB._id])).toEqual(['native', 'native']);

  const second = await migrate({ apply: true, now: NOW });
  expect(entryFor(second, 'maya-agent')).toMatchObject({ alreadyMigrated: true, tokensRevoked: 1 });
  expect(mockDeprovision).toHaveBeenCalledTimes(1); // not stopped twice
});

test('a provisioned identity is refused when the worker is not configured (Rhea 3)', async () => {
  mockConfigured = false;

  const report = await migrate({ apply: true, now: NOW });

  expect(entryFor(report, 'maya-agent').error).toMatch(/cannot be stopped; refused/);
  expect(await engines([maya._id, mayaB._id])).toEqual([undefined, undefined]);
  expect(mockRevoke).not.toHaveBeenCalledWith(expect.objectContaining({ agentName: 'maya-agent' }));
  // A stopped identity needs no worker and still moves.
  expect(await engines([idle._id])).toEqual(['native']);
});

test('pending events: recent on a running install go to the sweep; on a stopped one, or stale, they close (Rhea 4, sprint-review)', async () => {
  const at = (ms) => new Date(NOW.getTime() - ms);
  const [toSweep, stale, onStopped] = await AgentEvent.create([
    { agentName: 'maya-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending', createdAt: at(60 * 1000) },
    { agentName: 'maya-agent', instanceId: 'default', podId: podB, type: 'chat.mention', payload: {}, status: 'pending', createdAt: at(60 * 60 * 1000) },
    { agentName: 'idle-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending', createdAt: at(60 * 1000) },
  ]);

  const dry = await migrate({ apply: false, now: NOW });
  expect(entryFor(dry, 'maya-agent')).toMatchObject({ pendingToSweep: 1, pendingClosed: 1 });
  expect(entryFor(dry, 'idle-agent')).toMatchObject({ pendingToSweep: 0, pendingClosed: 1 });

  await migrate({ apply: true, now: NOW });

  const swept = await AgentEvent.findById(toSweep._id).lean();
  expect(swept).toMatchObject({ status: 'delivered', deliveryNonce: null });
  expect((await AgentEvent.findById(stale._id).lean())).toMatchObject({ status: 'failed', error: expect.stringMatching(/stale/) });
  expect((await AgentEvent.findById(onStopped._id).lean())).toMatchObject({ status: 'failed', error: expect.stringMatching(/stopped/) });
});

test('a stopped install stays stopped with no worker call; one born native is not touched or reported', async () => {
  const report = await migrate({ apply: true, now: NOW });

  expect(await hostedOf(idle._id)).toEqual(expect.objectContaining({ engine: 'native', provisionedAt: null }));
  expect(mockDeprovision).not.toHaveBeenCalledWith('idle-agent', 'default');
  expect((await hostedOf(born._id)).migratedFrom).toBeUndefined();
  expect(entryFor(report, 'native-agent')).toBeUndefined();
});
