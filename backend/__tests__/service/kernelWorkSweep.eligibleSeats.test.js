/**
 * F632: the kernel work sweep reads only seats that can ever be woken.
 *
 * Measured on prod 2026-11-25: 2,224 pending unassigned rows across 727 pods,
 * none of them with an eligible implementer seat. Every pass aggregated all of
 * them, read every active install in those 727 pods (full documents, configs
 * of tens of KB), then walked 727 pods to wake nobody — one core for 10–15 s
 * every ten minutes, 5.7 s of event-loop lag and PG pool timeouts behind it.
 *
 * These run against real Mongo with the real AgentInstallation model, because
 * `config` is a Mongoose Map and the fix filters on dotted paths inside it.
 * A mock would agree with any query; only mongod says whether it matches.
 */
/* eslint-disable import/no-unresolved, import/extensions */
const mongoose = require('mongoose');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

const Task = require('../../models/Task');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const KernelWorkSweepService = require('../../services/kernelWorkSweepService');

const NOW = new Date('2026-08-20T20:00:00.000Z');
const INSTALLER = new mongoose.Types.ObjectId();
const IMPLEMENTER = { enabled: true, role: 'implementer' };

const installDoc = (podId, agentName, config) => ({
  agentName,
  instanceId: 'default',
  podId,
  version: '1.0.0',
  installedBy: INSTALLER,
  status: 'active',
  config,
});

// Through the model, so `config` is cast to the Map and stored the way prod
// stores it.
const addInstall = (podId, agentName, config) => AgentInstallation.create(installDoc(podId, agentName, config));

let taskNum = 0;
const dueTask = (podId, taskId) => {
  taskNum += 1;
  return {
    podId, taskNum, taskId, title: taskId, status: 'pending', assignee: null,
  };
};

beforeAll(async () => {
  await setupMongoDb();
  await Task.init();
  await AgentInstallation.init();
});

beforeEach(async () => {
  await clearMongoDb();
  jest.clearAllMocks();
  taskNum = 0;
  AgentEventService.enqueue.mockResolvedValue({});
});

afterAll(async () => {
  await clearMongoDb();
  await closeMongoDb();
});

describe('F632 — the sweep reads only seats that can be woken', () => {
  it('(a) 700 pods of due work and no eligible seat: no wake, nothing stamped, nothing scanned', async () => {
    const pods = Array.from({ length: 700 }, () => new mongoose.Types.ObjectId());
    await Task.insertMany(pods.map((podId, i) => dueTask(podId, `TASK-${i}`)));
    // Installs that can never be woken by discovery: no workDiscovery at all,
    // a reviewer, discovery switched off — all with board/chat wake on.
    await AgentInstallation.insertMany(pods.map((podId, i) => {
      const variants = [
        { wakeOnMessage: { enabled: true } },
        { boardWake: { enabled: true }, workDiscovery: { enabled: true, role: 'reviewer' } },
        { boardWake: { enabled: true }, workDiscovery: { enabled: false, role: 'implementer' } },
      ];
      return installDoc(podId, `seat-${i}`, variants[i % variants.length]);
    }));
    const aggregate = jest.spyOn(Task, 'aggregate');

    const result = await KernelWorkSweepService.wakeForFoundWork(NOW);

    expect(result).toEqual({ woken: 0, skippedNoWork: 0, scannedPods: 0 });
    // Stop early: with no seat to wake, the 700-pod aggregate never runs.
    expect(aggregate).not.toHaveBeenCalled();
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(await Task.countDocuments({ offeredAt: { $exists: true } })).toBe(0);
    aggregate.mockRestore();
  });

  it('(b) an eligible implementer with wakeOnMessage on is woken exactly as before, and its rows stamped', async () => {
    const pod = new mongoose.Types.ObjectId();
    const quiet = new mongoose.Types.ObjectId();
    await Task.insertMany([dueTask(pod, 'TASK-1'), dueTask(pod, 'TASK-2'), dueTask(quiet, 'TASK-QUIET')]);
    await addInstall(pod, 'impl', {
      wakeOnMessage: { enabled: true },
      workDiscovery: IMPLEMENTER,
      persona: 'x'.repeat(30000),
    });
    // A reviewer in the same pod is still not woken.
    await addInstall(pod, 'rev', { boardWake: { enabled: true }, workDiscovery: { enabled: true, role: 'reviewer' } });

    const result = await KernelWorkSweepService.wakeForFoundWork(NOW);

    expect(result).toEqual({ woken: 1, skippedNoWork: 0, scannedPods: 1 });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const [event] = AgentEventService.enqueue.mock.calls[0];
    expect(event).toMatchObject({
      agentName: 'impl',
      instanceId: 'default',
      podId: String(pod),
      type: 'message.posted',
      payload: {
        podId: String(pod), boardWake: true, boardChanges: 0, foundWorkAt: NOW, triggerAuthor: 'kernel',
      },
    });
    expect(event.payload).not.toHaveProperty('dmKind');
    const { content } = event.payload;
    expect(content.startsWith('[The kernel found unclaimed work in this pod — 2 pending, unassigned:]')).toBe(true);
    expect(content).toContain('- TASK-1 — [P2] TASK-1');
    expect(content).toContain('- TASK-2 — [P2] TASK-2');
    expect(content).not.toContain('TASK-QUIET');

    const rows = await Task.find({ podId: pod }).lean();
    rows.forEach((row) => expect(row.offeredAt).toEqual(row.updatedAt));
    expect((await Task.findOne({ podId: quiet }).lean()).offeredAt).toBeUndefined();
    const reserved = await AgentInstallation.findOne({ podId: pod, agentName: 'impl' }).lean();
    expect(reserved.lastFoundWorkAt).toEqual(NOW);
  });

  it('(c) an eligible implementer with boardWake.enabled false is not woken', async () => {
    const pod = new mongoose.Types.ObjectId();
    await Task.create(dueTask(pod, 'TASK-1'));
    await addInstall(pod, 'impl', {
      boardWake: { enabled: false }, wakeOnMessage: { enabled: true }, workDiscovery: IMPLEMENTER,
    });

    const result = await KernelWorkSweepService.wakeForFoundWork(NOW);

    // The query admits it (discovery is on); notifyFoundWork's own filter
    // stays the final check and refuses it.
    expect(result).toEqual({ woken: 0, skippedNoWork: 1, scannedPods: 1 });
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect((await Task.findOne({ podId: pod }).lean()).offeredAt).toBeUndefined();
  });

  it('(d) rows in a pod with no eligible seat stay due, and wake once an eligible install arrives', async () => {
    const waiting = new mongoose.Types.ObjectId();
    const elsewhere = new mongoose.Types.ObjectId();
    await Task.insertMany([dueTask(waiting, 'TASK-WAIT'), dueTask(elsewhere, 'TASK-ELSE')]);
    // An eligible seat exists, but in another pod: the sweep must not read
    // past its own pods to find work for it.
    await addInstall(elsewhere, 'other', { boardWake: { enabled: true }, workDiscovery: IMPLEMENTER });
    await addInstall(waiting, 'chatty', { wakeOnMessage: { enabled: true } });

    const first = await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(first).toEqual({ woken: 1, skippedNoWork: 0, scannedPods: 1 });
    expect(AgentEventService.enqueue.mock.calls[0][0].podId).toBe(String(elsewhere));
    expect((await Task.findOne({ podId: waiting }).lean()).offeredAt).toBeUndefined();

    await addInstall(waiting, 'impl', { boardWake: { enabled: true }, workDiscovery: IMPLEMENTER });
    const later = await KernelWorkSweepService.wakeForFoundWork(new Date(NOW.getTime() + 600000));

    expect(later).toEqual({ woken: 1, skippedNoWork: 0, scannedPods: 1 });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
    const [second] = AgentEventService.enqueue.mock.calls[1];
    expect(second).toMatchObject({ agentName: 'impl', podId: String(waiting) });
    expect(second.payload.content).toContain('TASK-WAIT');
    const row = await Task.findOne({ podId: waiting }).lean();
    expect(row.offeredAt).toEqual(row.updatedAt);
  });

  it('(e) the eligible-install read throws: logged once, each pod reads its own installs', async () => {
    // Review-checklist rule 19: a failed lookup fails toward over-delivery.
    const pod = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await Task.insertMany([dueTask(pod, 'TASK-1'), dueTask(other, 'TASK-OTHER')]);
    await addInstall(pod, 'impl', { boardWake: { enabled: true }, workDiscovery: IMPLEMENTER });
    await addInstall(other, 'chatty', { wakeOnMessage: { enabled: true } });
    const find = jest.spyOn(AgentInstallation, 'find').mockImplementationOnce(() => ({
      lean: () => Promise.reject(new Error('pool closed')),
    }));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await KernelWorkSweepService.sweep(NOW);

    // The old pass: every pod with due work scanned, each reading its own
    // installs (one failed read plus one per pod), the eligible seat woken.
    expect(result).toMatchObject({ woken: 1, scannedPods: 2, skippedNoWork: 1 });
    expect(find).toHaveBeenCalledTimes(3);
    expect(find.mock.calls.slice(1).map(([filter]) => String(filter.podId)).sort())
      .toEqual([String(pod), String(other)].sort());
    const logged = error.mock.calls.filter((call) => call.some((arg) => String(arg).includes('[kernel-sweep]')));
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('pool closed');
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const [event] = AgentEventService.enqueue.mock.calls[0];
    expect(event).toMatchObject({ agentName: 'impl', podId: String(pod), payload: { triggerAuthor: 'kernel' } });
    expect(event.payload.content).toContain('- TASK-1 — [P2] TASK-1');
    const woken = await Task.findOne({ podId: pod }).lean();
    expect(woken.offeredAt).toEqual(woken.updatedAt);
    expect((await Task.findOne({ podId: other }).lean()).offeredAt).toBeUndefined();

    find.mockRestore();
    error.mockRestore();
  });

  it('reads only the fields the wake path uses, never the whole config', async () => {
    const pod = new mongoose.Types.ObjectId();
    await Task.create(dueTask(pod, 'TASK-1'));
    await addInstall(pod, 'impl', {
      boardWake: { enabled: true }, workDiscovery: IMPLEMENTER, persona: 'p'.repeat(40000), skills: ['a'],
    });
    const find = jest.spyOn(AgentInstallation, 'find');

    await KernelWorkSweepService.wakeForFoundWork(NOW);

    const [filter, projection] = find.mock.calls[0];
    expect(filter).toEqual({
      status: 'active',
      'config.workDiscovery.enabled': true,
      'config.workDiscovery.role': 'implementer',
    });
    expect(Object.keys(projection).sort()).toEqual([
      'agentName', 'config.boardWake', 'config.wakeOnMessage', 'config.workDiscovery', 'instanceId', 'podId', 'status',
    ]);
    find.mockRestore();
    // The same query against mongod returns the seat with only those config keys.
    const handed = await AgentInstallation.find(filter, projection).lean();
    expect(handed).toHaveLength(1);
    expect(handed[0].config).toEqual({ boardWake: { enabled: true }, workDiscovery: IMPLEMENTER });
  });
});
