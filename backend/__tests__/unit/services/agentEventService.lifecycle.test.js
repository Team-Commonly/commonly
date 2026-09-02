/**
 * AgentEvent lifecycle: the delivery counter and the terminal states.
 *
 * Four defects sat in one lifecycle, each one hiding the next:
 *
 *   1. `attempts` was never incremented anywhere in the pending↔delivered
 *      cycle, so every payload the kernel has ever served carried `attempts: 0`
 *      — the field ADR-004 §Event model obliges drivers to dedup with.
 *   2. Because nothing wrote it, `attempts < cap` in garbageCollect() was a
 *      guard on a frozen variable: structurally unable to fire.
 *   3. Turning the counter on without a cap-exhaustion pass would have been
 *      worse than leaving it off — a capped event fails the requeue predicate,
 *      and a 'delivered' row is invisible to list(), so it would sit stuck for
 *      the full 168h retention window. That is the Task #67 symptom the
 *      requeue exists to fix, recreated by its own fix.
 *   4. Two driver classes never reach a terminal state at all, so the requeue
 *      was picking up work that had already succeeded — for webhooks that
 *      meant re-POSTing a handled event every ~10-20 min, forever.
 *
 * These tests pin the counter's single owner and each terminal transition. The
 * assertions are deliberately about the QUERY SHAPE rather than about observed
 * counts: this is a mocked-model suite, so a test that only checked "some
 * update happened" would pass against every one of the four bugs above.
 */

jest.mock('../../../models/AgentEvent', () => ({
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  find: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
}));

jest.mock('../../../models/AgentMemory', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../../models/Task', () => ({
  aggregate: jest.fn(),
}));

jest.mock('../../../services/agentMemoryService', () => ({
  buildMemoryDigestBundle: jest.fn(() => ({})),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));

jest.mock('../../../models/Integration', () => ({}));
jest.mock('../../../models/Gateway', () => ({ findById: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(() => 'acct'),
}));
jest.mock('../../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));

const AgentEvent = require('../../../models/AgentEvent');
const AgentMemory = require('../../../models/AgentMemory');
const Task = require('../../../models/Task');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEventService = require('../../../services/agentEventService');
const { runAgent } = require('../../../services/nativeRuntimeService');

// Let fire-and-forget promise chains (webhook delivery, native settle) run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const lastCall = (mockFn) => mockFn.mock.calls[mockFn.mock.calls.length - 1];

describe('attempts is a delivery counter with exactly one writer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ revision: 3, lastSeenRevision: 1 }) }),
    });
  });

  test('list() increments attempts on the pending → delivered claim', async () => {
    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({ select: () => ({ lean: () => Promise.resolve([{ _id: 'evt-1' }]) }) }),
      }),
    });
    AgentEvent.findOneAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({
        _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: 'p1',
        type: 'chat.mention', payload: {}, status: 'delivered', attempts: 1,
      }),
    });

    await AgentEventService.list({ agentName: 'pixel', instanceId: 'default' });

    const [filter, update, options] = lastCall(AgentEvent.findOneAndUpdate);
    expect(filter).toEqual({ _id: 'evt-1', status: 'pending' });
    // The claim IS the delivery — ADR-004 §Event model.
    expect(update.$inc).toEqual({ attempts: 1 });
    expect(update.$set).toEqual(expect.objectContaining({ status: 'delivered' }));
    // `new: true` is what makes the incremented value the one the driver is
    // handed. Without it the payload would still report the pre-claim count.
    expect(options).toEqual({ new: true });
  });

  test('acknowledge() does NOT increment — an ack is not a delivery', async () => {
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: 'p1',
      type: 'chat.mention', payload: {}, status: 'acked', memoryRevisionAtDelivery: 0,
    });

    await AgentEventService.acknowledge('evt-1', 'pixel', 'default', { outcome: 'no_action' });

    const [, update] = lastCall(AgentEvent.findOneAndUpdate);
    expect(update.$set).toEqual(expect.objectContaining({ status: 'acked' }));
    // Double-counting here is what made a normally-handled event read
    // `attempts: 2` and turned the field into "deliveries plus transitions."
    expect(update.$inc).toBeUndefined();
  });

  test('recordFailure() does NOT increment either', async () => {
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: 'p1',
      type: 'chat.mention', payload: {}, status: 'failed',
    });

    await AgentEventService.recordFailure('evt-1', 'pixel', 'default', 'boom');

    const [, update] = lastCall(AgentEvent.findOneAndUpdate);
    expect(update.$set).toEqual(expect.objectContaining({ status: 'failed', error: 'boom' }));
    expect(update.$inc).toBeUndefined();
  });
});

describe('heartbeat task-update cue', () => {
  const podId = { toString: () => '64f000000000000000000001' };
  let lastCycleAt;

  beforeEach(() => {
    jest.clearAllMocks();
    lastCycleAt = new Date(Date.now() - (10 * 60 * 1000));
    AgentInstallation.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
      lean: () => Promise.resolve(null),
    });
    AgentInstallation.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    AgentEvent.create.mockImplementation(async (event) => ({
      _id: 'heartbeat-1',
      ...event,
      status: 'pending',
      attempts: 0,
    }));
  });

  test('counts updates since the latest cycle and prepends only an on-demand cue', async () => {
    AgentMemory.findOne.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          sections: {
            cycles: {
              // Deliberately unordered: the cursor is the newest valid entry,
              // not an assumed array position.
              entries: [{ ts: new Date(lastCycleAt.getTime() - (30 * 60 * 1000)) }, { ts: lastCycleAt }],
            },
          },
        }),
      }),
    });
    Task.aggregate.mockResolvedValue([{ count: 2 }]);

    await AgentEventService.enqueue({
      agentName: 'scout', instanceId: 'workspace-a', podId, type: 'heartbeat',
      payload: { content: 'Scheduler heartbeat for pod 64f000000000000000000001.' },
    });

    expect(Task.aggregate).toHaveBeenCalledWith([
      { $match: { podId } },
      { $unwind: '$updates' },
      { $match: { 'updates.createdAt': { $gt: lastCycleAt } } },
      { $count: 'count' },
    ]);
    const payload = AgentEvent.create.mock.calls[0][0].payload;
    expect(payload.content).toContain('[tasks: 2 task updates since your last cycle — call commonly_get_tasks if relevant.]');
    expect(payload.content).toContain('Scheduler heartbeat for pod');
    expect(payload.content).not.toContain('Claimed by');
  });

  test('skips the query before an agent has logged a cycle', async () => {
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ sections: { cycles: { entries: [] } } }) }),
    });

    await AgentEventService.enqueue({
      agentName: 'scout', instanceId: 'workspace-a', podId, type: 'heartbeat',
      payload: { content: 'Scheduler heartbeat for pod 64f000000000000000000001.' },
    });

    expect(Task.aggregate).not.toHaveBeenCalled();
    expect(AgentEvent.create.mock.calls[0][0].payload.content).not.toContain('[tasks:');
  });

  test('skips the query when the last cycle is stale', async () => {
    AgentMemory.findOne.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          sections: { cycles: { entries: [{ ts: new Date(Date.now() - (25 * 60 * 60 * 1000)) }] } },
        }),
      }),
    });

    await AgentEventService.enqueue({
      agentName: 'scout', instanceId: 'workspace-a', podId, type: 'heartbeat',
      payload: { content: 'Scheduler heartbeat for pod 64f000000000000000000001.' },
    });

    expect(Task.aggregate).not.toHaveBeenCalled();
    expect(AgentEvent.create.mock.calls[0][0].payload.content).not.toContain('[tasks:');
  });

  test('keeps the heartbeat intact when the task aggregate fails', async () => {
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ sections: { cycles: { entries: [{ ts: lastCycleAt }] } } }) }),
    });
    Task.aggregate.mockRejectedValue(new Error('board unavailable'));

    await AgentEventService.enqueue({
      agentName: 'scout', instanceId: 'workspace-a', podId, type: 'heartbeat',
      payload: { content: 'Scheduler heartbeat for pod 64f000000000000000000001.' },
    });

    expect(AgentEvent.create.mock.calls[0][0].payload.content)
      .toBe('Scheduler heartbeat for pod 64f000000000000000000001.');
  });
});

describe('garbageCollect: the requeue predicate and its cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.updateMany.mockResolvedValue({ modifiedCount: 0 });
    AgentEvent.deleteMany.mockResolvedValue({ deletedCount: 0 });
  });

  const passes = () => AgentEvent.updateMany.mock.calls.map(([filter, update]) => ({ filter, update }));

  test('requeue no longer filters on the phantom `ackedAt` field', async () => {
    await AgentEventService.garbageCollect({});

    const [requeue] = passes();
    // `ackedAt` is not on IAgentEvent and not in the schema — Mongoose stripped
    // it, so the clause matched every document and read as a live narrowing to
    // anyone auditing the predicate. Asserting its ABSENCE is the point: a test
    // that only checked the surviving keys would pass with it still there.
    expect(Object.keys(requeue.filter)).not.toContain('ackedAt');
    expect(requeue.filter).toEqual(expect.objectContaining({ status: 'delivered' }));
    expect(requeue.update.$set).toEqual({
      status: 'pending',
      deliveredAt: null,
      // ADR-026 D6: the requeue clearing the nonce IS the invalidation — it is
      // what stops the superseded child's late ack from terminating the
      // replacement's delivery. Asserted here as well as in the D6 suite
      // because this is the test that reads the whole $set exhaustively, so a
      // future edit that drops the field fails here first.
      deliveryNonce: null,
    });
  });

  test('a second pass retires cap-exhausted events to the terminal failed state', async () => {
    await AgentEventService.garbageCollect({ requeueMaxAttempts: 3 });

    const expire = passes().find((p) => p.update.$set?.status === 'failed');
    expect(expire).toBeDefined();
    expect(expire.filter).toEqual(expect.objectContaining({
      status: 'delivered',
      attempts: { $gte: 3 },
    }));
    expect(expire.update.$set.error).toMatch(/cap exhausted/i);
  });

  test('the two passes are disjoint — no document can be touched by both', async () => {
    await AgentEventService.garbageCollect({ requeueMaxAttempts: 3 });

    const requeue = passes().find((p) => p.update.$set?.status === 'pending');
    const expire = passes().find((p) => p.update.$set?.status === 'failed');

    // Disjointness rides on `attempts` alone: < cap vs >= cap. If a future edit
    // makes the expire pass `$gt` (or the requeue `$lte`), one GC run could
    // requeue an event and immediately fail it, losing the redelivery.
    expect(requeue.filter.$or).toEqual([
      { attempts: { $lt: 3 } },
      { attempts: { $exists: false } },
    ]);
    expect(expire.filter.attempts).toEqual({ $gte: 3 });
  });

  // #993: the requeue (`requeueResult = await AgentEvent.updateMany`) and the
  // pending delete (`deleteMany({ status: 'pending' ... })`) ran in the same
  // Promise.all against different fields — the requeue sets `status` but not
  // `createdAt`, so an event it had just rescued walked into a `createdAt`-keyed
  // delete carrying its original age. 38 events were destroyed in one measured
  // hour, and the log paired them per run (11:00: requeued 17, deletedPending 17).
  //
  // These pin the horizon rather than the mechanism: as long as pending ages out
  // on the SAME schedule as everything else, no rescue can be undone by a sweep
  // in its own pass, and a seat can be down for a restart or a quota reset
  // without its queue being destroyed underneath it.
  const deletes = () => AgentEvent.deleteMany.mock.calls.map(([filter]) => filter);

  test('pending events age out on the same horizon as delivered and acked', async () => {
    await AgentEventService.garbageCollect({});

    const pending = deletes().find((f) => f.status === 'pending');
    const settled = deletes().find((f) => Array.isArray(f.status?.$in));

    expect(pending).toBeDefined();
    expect(settled).toBeDefined();
    // Same instant, not merely "both long": a shorter pending horizon is exactly
    // what let the sweep outrun the retry lifecycle.
    expect(pending.createdAt.$lt.getTime()).toBe(settled.createdAt.$lt.getTime());
  });

  test('no delete predicate can destroy a pending event inside the retry window', async () => {
    // The retry ceiling is 15 min x 1.2 jitter = 18 min (cli spawn-retry), and a
    // seat restart is unbounded. Any pending horizon shorter than the retention
    // one re-arms both. 24h is a deliberately loose floor — the real value is
    // 168h — so this fails on a regression rather than on a retuning.
    await AgentEventService.garbageCollect({});

    const now = Date.now();
    for (const filter of deletes()) {
      const targetsPending = filter.status === 'pending'
        || (Array.isArray(filter.status?.$in) && filter.status.$in.includes('pending'));
      if (!targetsPending) continue;
      expect(now - filter.createdAt.$lt.getTime()).toBeGreaterThan(24 * 60 * 60 * 1000);
    }
  });

  test('reports what it retired, so a poison-event backlog is visible in ops output', async () => {
    AgentEvent.updateMany
      .mockResolvedValueOnce({ modifiedCount: 2 })   // requeued
      .mockResolvedValueOnce({ modifiedCount: 5 });  // expired

    const result = await AgentEventService.garbageCollect({});

    expect(result.requeuedDelivered).toBe(2);
    expect(result.expiredDelivered).toBe(5);
  });
});

describe('driver paths reach a terminal state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.findOne.mockResolvedValue(null);
    AgentEvent.findByIdAndUpdate.mockResolvedValue({});
  });

  test('a successful webhook POST terminates as acked, not delivered', async () => {
    AgentEvent.create.mockResolvedValue({
      _id: 'evt-w', agentName: 'hookbot', instanceId: 'default', podId: 'p1',
      type: 'chat.mention', payload: {}, status: 'pending', attempts: 0,
    });
    AgentInstallation.find.mockReturnValue({
      lean: () => Promise.resolve([{
        agentName: 'hookbot',
        config: { runtime: { webhookUrl: 'https://example.test/hook' } },
      }]),
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ outcome: 'no_action' }),
    });

    await AgentEventService.enqueue({
      agentName: 'hookbot', instanceId: 'default', podId: 'p1', type: 'chat.mention', payload: {},
    });
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, update] = lastCall(AgentEvent.findByIdAndUpdate);
    // 'delivered' here is what fed a handled event back into the requeue
    // population and re-POSTed it ~10-20 min later, indefinitely.
    expect(update.status).toBe('acked');
    expect(update['delivery.outcome']).toBe('no_action');
  });

  describe('native runtime', () => {
    const nativeInstall = {
      _id: 'inst-n',
      agentName: 'clerk',
      config: { runtime: { runtimeType: 'native' } },
    };

    const enqueueNative = async () => {
      AgentInstallation.findOne.mockReturnValue({ lean: () => Promise.resolve(nativeInstall) });
      AgentInstallation.find.mockReturnValue({ lean: () => Promise.resolve([]) });
      AgentEvent.create.mockResolvedValue({
        _id: 'evt-n', agentName: 'clerk', instanceId: 'default', podId: 'p1',
        type: 'task.assigned', payload: {}, status: 'delivered', attempts: 1,
      });
      await AgentEventService.enqueue({
        agentName: 'clerk', instanceId: 'default', podId: 'p1', type: 'task.assigned', payload: {},
      });
      await flush();
      await flush();
    };

    test('creates the event already counted as one delivery', async () => {
      runAgent.mockResolvedValue({ ok: true });

      await enqueueNative();

      // list() never claims a native event, so if the create doesn't count the
      // delivery nothing ever will — and the driver sees attempts: 0 on an
      // event that has been delivered exactly once.
      expect(AgentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        status: 'delivered',
        attempts: 1,
      }));
    });

    test('a completed run acks — without this the requeue hands it to an external poller', async () => {
      runAgent.mockResolvedValue({ ok: true });
      AgentEvent.findOneAndUpdate.mockResolvedValue({
        _id: 'evt-n', agentName: 'clerk', instanceId: 'default', podId: 'p1',
        type: 'task.assigned', payload: {}, status: 'acked', memoryRevisionAtDelivery: 0,
      });

      await enqueueNative();

      const acked = AgentEvent.findOneAndUpdate.mock.calls
        .find(([, update]) => update.$set?.status === 'acked');
      expect(acked).toBeDefined();
      expect(acked[0]).toEqual(expect.objectContaining({ _id: 'evt-n' }));
    });

    test('a failed run is terminal too, not left for redelivery', async () => {
      runAgent
        .mockRejectedValue(new Error('model timeout'));
      AgentEvent.findOneAndUpdate.mockResolvedValue({
        _id: 'evt-n', agentName: 'clerk', instanceId: 'default', podId: 'p1',
        type: 'task.assigned', payload: {}, status: 'failed',
      });

      await enqueueNative();

      const failed = AgentEvent.findOneAndUpdate.mock.calls
        .find(([, update]) => update.$set?.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed[1].$set.error).toMatch(/native runtime error: model timeout/);
    });

    test('an ack that itself fails does not get reported as a failed run', async () => {
      // The rejection handler is scoped to runAgent via two-argument .then. A
      // chained .catch would swallow this ack rejection and then mark a run
      // that actually succeeded as 'failed' — silently inverting the outcome.
      runAgent.mockResolvedValue({ ok: true });
      AgentEvent.findOneAndUpdate.mockRejectedValue(new Error('mongo down'));

      await enqueueNative();

      const failed = AgentEvent.findOneAndUpdate.mock.calls
        .find(([, update]) => update.$set?.status === 'failed');
      expect(failed).toBeUndefined();
    });
  });
});
