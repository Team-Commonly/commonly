/**
 * TASK-265: the hosted-engine migration, forward-only and resumable. Real
 * installation, event and user models on an in-memory Mongo; the worker
 * calls and the token revoke are mocked. The arms are Rhea's and
 * sprint-review's findings across three reviews of #2236: each step can fail,
 * and the next run must finish the identity from where it stopped.
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
const readStoredEngine = (row) => require('../../../services/hostedEngine').hostedEngineOf(row);
const field = async (ids, pick) => Promise.all(ids.map(async (id) => pick((await hostedOf(id)) || {})));
const entryFor = (report, name) => report.identities.find((row) => row.agentName === name);
const stopsFor = (name) => mockDeprovision.mock.calls.filter(([agentName]) => agentName === name).length;
const revokedFor = (name) => mockRevoke.mock.calls.filter(([args]) => args.agentName === name).length;

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
  expect(report.identities.map((row) => [row.agentName, row.installs, row.doProvisioned, row.from]).sort())
    .toEqual([['idle-agent', 1, false, 'new'], ['maya-agent', 2, true, 'new']]);
  expect(mockDeprovision).not.toHaveBeenCalled();
  expect(await field([maya._id, mayaB._id], (h) => h.engine)).toEqual([undefined, undefined]);
});

test('a clean run: marked native before the revoke, stopped, revoked, done', async () => {
  let enginesAtRevoke;
  mockRevoke.mockImplementation(async () => {
    enginesAtRevoke = await field([maya._id, mayaB._id], (h) => h.engine);
    return ['hash-1'];
  });

  const report = await migrate({ apply: true, now: NOW });

  expect(enginesAtRevoke).toEqual(['native', 'native']);
  expect(entryFor(report, 'maya-agent')).toMatchObject({ reached: 'done', durableObjectStopped: true, tokensRevoked: 1 });
  expect(await hostedOf(maya._id)).toEqual(expect.objectContaining({
    engine: 'native', provisionedAt: NOW, about: 'Keeps the research log.', migratedFrom: 'durable-object',
    migration: { state: 'done', doProvisioned: true },
  }));
  // A second run has nothing left to do for a done identity.
  jest.clearAllMocks();
  const again = await migrate({ apply: true, now: NOW });
  expect(entryFor(again, 'maya-agent')).toBeUndefined();
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('marking interrupted part-way: the next run marks the rest and finishes', async () => {
  const original = AgentInstallation.updateOne.bind(AgentInstallation);
  const spy = jest.spyOn(AgentInstallation, 'updateOne').mockImplementation((filter, update, ...rest) => {
    if (String(filter?._id) === String(mayaB._id) && update?.$set?.['config.hosted']) return Promise.reject(new Error('write failed'));
    return original(filter, update, ...rest);
  });
  const first = await migrate({ apply: true, now: NOW });
  expect(entryFor(first, 'maya-agent')).toMatchObject({ reached: 'mark', error: expect.stringMatching(/run again/) });
  expect(mockDeprovision).not.toHaveBeenCalledWith('maya-agent', 'default');

  spy.mockRestore();
  const second = await migrate({ apply: true, now: NOW });
  expect(entryFor(second, 'maya-agent')).toMatchObject({ reached: 'done', durableObjectStopped: true });
  expect(await field([maya._id, mayaB._id], (h) => h.migration?.state)).toEqual(['done', 'done']);
});

test('a stop that failed is retried on the next run, not assumed (Rhea: marker is not shutdown)', async () => {
  let failed = false;
  mockDeprovision.mockImplementation(async (name) => {
    if (name === 'maya-agent' && !failed) { failed = true; throw new Error('worker down'); }
    return true;
  });
  const first = await migrate({ apply: true, now: NOW });
  expect(entryFor(first, 'maya-agent')).toMatchObject({ reached: 'stop', error: expect.stringMatching(/run again to stop/) });
  expect(await field([maya._id, mayaB._id], (h) => h.migration?.state)).toEqual(['marked', 'marked']);
  expect(revokedFor('maya-agent')).toBe(0);

  const second = await migrate({ apply: true, now: NOW });
  expect(entryFor(second, 'maya-agent')).toMatchObject({ from: 'marked', reached: 'done', durableObjectStopped: true });
  expect(stopsFor('maya-agent')).toBe(2);
});

test('a failed revoke resumes at the revoke, without stopping the worker twice', async () => {
  let failed = false;
  mockRevoke.mockImplementation(async ({ agentName }) => {
    if (agentName === 'maya-agent' && !failed) { failed = true; throw new Error('db down'); }
    return ['hash-1'];
  });
  const first = await migrate({ apply: true, now: NOW });
  expect(entryFor(first, 'maya-agent')).toMatchObject({ reached: 'revoke' });

  const second = await migrate({ apply: true, now: NOW });
  expect(entryFor(second, 'maya-agent')).toMatchObject({ from: 'stopped', reached: 'done', tokensRevoked: 1 });
  expect(stopsFor('maya-agent')).toBe(1);
});

// Rhea on #2236 (a600bf3d): a provision can complete between this run's read
// and its mark, so the stop cannot be decided from what the run read. With the
// worker configured every identity is stopped; the worker's stop is a no-op for
// an agent it is not running.
test('an identity this run saw unprovisioned is still stopped when the worker is configured', async () => {
  const report = await migrate({ apply: true, now: NOW });
  expect(entryFor(report, 'idle-agent')).toMatchObject({ doProvisioned: false, reached: 'done', durableObjectStopped: true });
  expect(stopsFor('idle-agent')).toBe(1);
  expect(stopsFor('native-agent')).toBe(0);
});

test('with no worker configured, an unprovisioned identity migrates without a stop and a provisioned one is refused', async () => {
  mockConfigured = false;
  const report = await migrate({ apply: true, now: NOW });
  expect(entryFor(report, 'idle-agent')).toMatchObject({ reached: 'done' });
  expect(entryFor(report, 'idle-agent').durableObjectStopped).toBeUndefined();
  expect(entryFor(report, 'maya-agent')).toMatchObject({ reached: 'refused' });
  expect(mockDeprovision).not.toHaveBeenCalled();
});

// Rhea on #2236 (a600bf3d), item 1: until the identity is done, its rows are
// not native for execution, grant eligibility or joins, whichever step failed.
// Checked on the rows exactly as the migration leaves them in the store.
test.each([
  ['a failed stop', 'stop'],
  ['a failed revoke', 'revoke'],
])('after %s the rows are native for nothing; once done, for everything', async (_label, failAt) => {
  const { hostedRunsNative, runsInNarrowedProcess, hostedEngineInEffect } = require('../../../services/hostedEngine');
  // Fail maya's step once; the other identities run normally.
  let failed = false;
  const failMayaOnce = (fallback) => async (arg) => {
    const name = typeof arg === 'string' ? arg : arg.agentName;
    if (name === 'maya-agent' && !failed) { failed = true; throw new Error(`${failAt} failed`); }
    return fallback;
  };
  if (failAt === 'stop') mockDeprovision.mockImplementation(failMayaOnce(true));
  else mockRevoke.mockImplementation(failMayaOnce(['hash-1']));
  const first = await migrate({ apply: true, now: NOW });
  expect(entryFor(first, 'maya-agent')).toMatchObject({ reached: failAt });

  const rowsNow = async () => Promise.all([maya._id, mayaB._id].map((id) => AgentInstallation.findById(id)));
  const stuck = await rowsNow();
  expect(stuck.map((row) => readStoredEngine(row))).toEqual(['native', 'native']);
  expect(stuck.map(hostedEngineInEffect)).toEqual(['durable-object', 'durable-object']);
  expect(stuck.map(hostedRunsNative)).toEqual([false, false]);
  expect(stuck.map(runsInNarrowedProcess)).toEqual([false, false]);

  await migrate({ apply: true, now: NOW });
  const finished = await rowsNow();
  expect(finished.map(hostedRunsNative)).toEqual([true, true]);
  expect(finished.map(runsInNarrowedProcess)).toEqual([true, true]);
  // A row born native was never migrated and is native throughout.
  const bornRow = await AgentInstallation.findById(born._id);
  expect(hostedRunsNative(bornRow)).toBe(true);
});

test('a failed event write is resumed: the next run handles the events and finishes (Rhea 4)', async () => {
  const [event] = await AgentEvent.create([{
    agentName: 'maya-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending',
    createdAt: new Date(NOW.getTime() - 60 * 1000),
  }]);
  const original = AgentEvent.updateOne.bind(AgentEvent);
  const spy = jest.spyOn(AgentEvent, 'updateOne').mockRejectedValueOnce(new Error('event write failed'));
  const first = await migrate({ apply: true, now: NOW });
  expect(entryFor(first, 'maya-agent')).toMatchObject({ reached: 'events' });
  expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');

  spy.mockImplementation((...args) => original(...args));
  const second = await migrate({ apply: true, now: NOW });
  expect(entryFor(second, 'maya-agent')).toMatchObject({ reached: 'done', pendingToSweep: 1 });
  expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
});

// Sprint-review on #2236: an interruption after marking (deploy, pod restart,
// kill) leaves exactly this persisted state, with no failure to inject. The
// dry run must count its events from the same query, and apply must finish it.
test.each([
  ['marked', 1],
  ['stopped', 0],
])('an identity persisted in state "%s" with a pending event is counted and resumed to done', async (state, stopCalls) => {
  await AgentInstallation.deleteMany({});
  const persisted = (podId) => install('resume-agent', podId, {
    engine: 'native', provisionedAt: NOW, migratedFrom: 'durable-object', migratedAt: NOW,
    migration: { state, doProvisioned: true },
  });
  const [rowA, rowB] = [await persisted(podA), await persisted(podB)];
  const [event] = await AgentEvent.create([{
    agentName: 'resume-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending',
    createdAt: new Date(NOW.getTime() - 60 * 1000),
  }]);

  const dry = await migrate({ apply: false, now: NOW });
  expect(entryFor(dry, 'resume-agent')).toMatchObject({ from: state, pendingToSweep: 1, pendingClosed: 0 });
  expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');

  const applied = await migrate({ apply: true, now: NOW });
  expect(entryFor(applied, 'resume-agent')).toMatchObject({ from: state, reached: 'done', pendingToSweep: 1 });
  expect(mockDeprovision).toHaveBeenCalledTimes(stopCalls);
  expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
  expect(await field([rowA._id, rowB._id], (h) => h.migration?.state)).toEqual(['done', 'done']);
});

test('a provisioned identity is refused when the worker is not configured; a stopped one still moves', async () => {
  mockConfigured = false;

  const report = await migrate({ apply: true, now: NOW });

  expect(entryFor(report, 'maya-agent')).toMatchObject({ reached: 'refused' });
  expect(await field([maya._id, mayaB._id], (h) => h.engine)).toEqual([undefined, undefined]);
  expect(entryFor(report, 'idle-agent')).toMatchObject({ reached: 'done' });
  expect(await hostedOf(idle._id)).toEqual(expect.objectContaining({ engine: 'native', provisionedAt: null }));
  expect(mockDeprovision).not.toHaveBeenCalled();
});

test('pending events: recent on a running install go to the sweep; on a stopped one, or stale, they close', async () => {
  const at = (ms) => new Date(NOW.getTime() - ms);
  const [toSweep, stale, onStopped] = await AgentEvent.create([
    { agentName: 'maya-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending', createdAt: at(60 * 1000) },
    { agentName: 'maya-agent', instanceId: 'default', podId: podB, type: 'chat.mention', payload: {}, status: 'pending', createdAt: at(60 * 60 * 1000) },
    { agentName: 'idle-agent', instanceId: 'default', podId: podA, type: 'chat.mention', payload: {}, status: 'pending', createdAt: at(60 * 1000) },
  ]);

  await migrate({ apply: true, now: NOW });

  expect(await AgentEvent.findById(toSweep._id).lean()).toMatchObject({ status: 'delivered', deliveryNonce: null });
  expect(await AgentEvent.findById(stale._id).lean()).toMatchObject({ status: 'failed', error: expect.stringMatching(/stale/) });
  expect(await AgentEvent.findById(onStopped._id).lean()).toMatchObject({ status: 'failed', error: expect.stringMatching(/stopped/) });
});

test('an install born native is never touched or reported', async () => {
  const report = await migrate({ apply: true, now: NOW });

  expect(entryFor(report, 'native-agent')).toBeUndefined();
  const hosted = await hostedOf(born._id);
  expect(hosted.migratedFrom).toBeUndefined();
  expect(hosted.migration).toBeUndefined();
});

// An event that arrives while the run works goes to the Durable Object path,
// since the rows are not native until 'done', and a later run skips a done
// identity. The run hands it off after recording done.
test('an event that arrives during the run is handed off after done, not stranded', async () => {
  let late;
  mockRevoke.mockImplementation(async ({ agentName }) => {
    if (agentName === 'maya-agent') {
      [late] = await AgentEvent.create([{
        agentName: 'maya-agent', instanceId: 'default', podId: podA, type: 'chat.mention', status: 'pending',
        createdAt: new Date(NOW.getTime() - 1000), payload: {},
      }]);
    }
    return ['hash-1'];
  });

  const report = await migrate({ apply: true, now: NOW });

  expect(entryFor(report, 'maya-agent')).toMatchObject({ reached: 'done', pendingToSweep: 0, lateEvents: 1 });
  const after = await AgentEvent.findById(late._id).lean();
  expect(after).toMatchObject({ status: 'delivered', deliveryNonce: null });
});
