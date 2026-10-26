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
  countDocuments: jest.fn(),
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  find: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
}));

jest.mock('../../../services/agentDigestFoldService', () => ({
  foldExpiredDigests: jest.fn().mockResolvedValue(0),
  readFoldedDigest: jest.fn().mockResolvedValue(null),
  settleFoldedDigest: jest.fn().mockResolvedValue(undefined),
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
// Webhook delivery goes through the open-destination guard. The mock runs the
// real guard unless a test overrides it, so a refusal arm exercises the real one.
jest.mock('../../../services/outboundUrlGuard', () => {
  const actual = jest.requireActual('../../../services/outboundUrlGuard');
  return { ...actual, postToPublicAddress: jest.fn(actual.postToPublicAddress) };
});

const http = require('http');
const https = require('https');
const AgentEvent = require('../../../models/AgentEvent');
const AgentMemory = require('../../../models/AgentMemory');
const Task = require('../../../models/Task');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEventService = require('../../../services/agentEventService');
const { runAgent } = require('../../../services/nativeRuntimeService');
const { settleFoldedDigest } = require('../../../services/agentDigestFoldService');
const { postToPublicAddress } = require('../../../services/outboundUrlGuard');

// Let fire-and-forget promise chains (webhook delivery, native settle) run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A real-shaped pod id: the in-process routing lookup refuses anything else.
const POD_P1 = '64b000000000000000000001';

const lastCall = (mockFn) => mockFn.mock.calls[mockFn.mock.calls.length - 1];

describe('attempts is a delivery counter with exactly one writer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.countDocuments.mockResolvedValue(1);
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
        _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: POD_P1,
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
      _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: POD_P1,
      type: 'chat.mention', payload: {}, status: 'acked', memoryRevisionAtDelivery: 0,
    });

    await AgentEventService.acknowledge('evt-1', 'pixel', 'default', { outcome: 'no_action' });

    const [, update] = lastCall(AgentEvent.findOneAndUpdate);
    expect(update.$set).toEqual(expect.objectContaining({ status: 'acked' }));
    // Double-counting here is what made a normally-handled event read
    // `attempts: 2` and turned the field into "deliveries plus transitions."
    expect(update.$inc).toBeUndefined();
  });

  test('a no-turn ack leaves folded digest and the memory read cursor unread', async () => {
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: POD_P1,
      type: 'heartbeat', status: 'acked', digestRollupRevision: 3,
      memoryRevisionAtDelivery: 7,
    });

    await AgentEventService.acknowledge('evt-1', 'pixel', 'default',
      { outcome: 'no_action', reason: 'native-no-turn' });

    expect(settleFoldedDigest).not.toHaveBeenCalled();
    expect(AgentMemory.updateOne).not.toHaveBeenCalled();
  });

  test('recordFailure() does NOT increment either', async () => {
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1', agentName: 'pixel', instanceId: 'default', podId: POD_P1,
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
    const settled = deletes().find((f) => f.status === 'acked');

    expect(pending).toBeDefined();
    expect(settled).toBeDefined();
    // Same instant, not merely "both long": a shorter pending horizon is exactly
    // what let the sweep outrun the retry lifecycle.
    expect(pending.createdAt.$lt.getTime()).toBe(settled.createdAt.$lt.getTime());
    expect(pending.deliveryMode).toEqual({ $ne: 'digest' });
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
      _id: 'evt-w', agentName: 'hookbot', instanceId: 'default', podId: POD_P1,
      type: 'chat.mention', payload: {}, status: 'pending', attempts: 0,
    });
    AgentInstallation.find.mockReturnValue({
      lean: () => Promise.resolve([{
        agentName: 'hookbot',
        config: { runtime: { webhookUrl: 'https://example.test/hook' } },
      }]),
    });
    postToPublicAddress.mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify({ outcome: 'no_action' }) });

    await AgentEventService.enqueue({
      agentName: 'hookbot', instanceId: 'default', podId: POD_P1, type: 'chat.mention', payload: {},
    });
    await flush();

    expect(postToPublicAddress).toHaveBeenCalledTimes(1);
    expect(postToPublicAddress.mock.calls[0][0]).toBe('https://example.test/hook');
    const [, update] = lastCall(AgentEvent.findByIdAndUpdate);
    // 'delivered' here is what fed a handled event back into the requeue
    // population and re-POSTed it ~10-20 min later, indefinitely.
    expect(update.status).toBe('acked');
    expect(update.delivery).toMatchObject({ outcome: 'no_action', reasonRecorded: true });
    expect(update.delivery.reason).toBeUndefined();
    expect(update.delivery.updatedAt).toBeInstanceOf(Date);
  });

  test.each(['http', 'timeout', 'error', 'non-error'])('webhook %s logs exclude secrets', async (failure) => {
    const webhookUrl = 'https://fake-user:fake-password@example.test/private-fake-path'
      + '?token=fake-query-secret#fake-fragment';
    const event = {
      _id: 'evt-private-hook',
      agentName: 'hookbot',
      instanceId: 'default',
      podId: POD_P1,
      type: 'chat.mention',
      payload: {},
      status: 'pending',
      attempts: 0,
    };
    AgentEvent.create.mockResolvedValue(event);
    AgentInstallation.findOne.mockReturnValue({ lean: async () => null });
    AgentEvent.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
    AgentInstallation.find.mockReturnValue({
      lean: async () => [{ config: { runtime: { webhookUrl } } }],
    });
    if (failure === 'http') {
      postToPublicAddress.mockResolvedValueOnce({ ok: false, status: 503, text: webhookUrl });
    } else {
      const error = new Error(`Request to ${webhookUrl} failed: fake-query-secret`);
      if (failure === 'timeout') error.name = 'AbortError';
      postToPublicAddress.mockRejectedValueOnce(failure === 'non-error' ? null : error);
    }
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await AgentEventService.enqueue({
        agentName: 'hookbot', instanceId: 'default', podId: POD_P1, type: 'chat.mention', payload: {},
      });
      await flush();

      expect(postToPublicAddress).toHaveBeenCalledWith(webhookUrl, expect.any(Object));
      expect(AgentEvent.findByIdAndUpdate).not.toHaveBeenCalled();
      const logs = JSON.stringify(warning.mock.calls);
      const sensitiveParts = [
        'fake-user', 'fake-password', 'fake-query-secret', 'private-fake-path', 'fake-fragment', 'example.test',
      ];
      sensitiveParts.forEach((secret) => {
        expect(logs).not.toContain(secret);
      });
      const diagnostic = {
        http: 'HTTP 503', timeout: 'timed out after 10s', error: 'delivery failed', 'non-error': 'delivery failed',
      }[failure];
      expect(warning).toHaveBeenCalledWith(`[webhook] hookbot ${diagnostic}`);
    } finally {
      warning.mockRestore();
    }
  });

  test.each([{ text: 'original text' }, { prompt: 'original prompt' }])('a webhook wake preserves fallback text and settles context after accepted delivery: %j', async (wakePayload) => {
    const ambient = {
      _id: 'ambient-1', agentName: 'hookbot', instanceId: 'default', podId: POD_P1,
      payload: { username: 'Alice', messageId: '42', threadRootId: 40, content: 'ambient note' },
    };
    const duplicate = { ...ambient, _id: 'ambient-2' };
    AgentEvent.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [ambient, duplicate] }) }) });
    AgentEvent.updateOne.mockResolvedValue({ matchedCount: 1 });
    AgentEvent.updateMany.mockResolvedValue({ modifiedCount: 1 });
    AgentEvent.create.mockResolvedValue({
      _id: 'evt-digest-wake', agentName: 'hookbot', instanceId: 'default', podId: POD_P1,
      type: 'chat.mention', payload: wakePayload, status: 'pending', attempts: 0,
    });
    AgentInstallation.find.mockReturnValue({
      lean: async () => [{ config: { runtime: { webhookUrl: 'https://example.test/hook' } } }],
    });
    postToPublicAddress.mockResolvedValueOnce({ ok: true, status: 200, text: '{"outcome":"no_action"}' });

    await AgentEventService.enqueue({
      agentName: 'hookbot', instanceId: 'default', podId: POD_P1, type: 'chat.mention', payload: {},
    });
    await flush();

    const body = JSON.parse(postToPublicAddress.mock.calls[0][1].body);
    expect(body.payload.content).toContain(wakePayload.prompt || wakePayload.text);
    expect(body.payload.digestSummary).toContain('thread 40: 1 unread');
    expect(body.payload.digestSummary).toContain('1 ambient update in 1 conversation');
    expect(body.payload.digestSummary).not.toContain('ambient note');
    expect(AgentEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ['ambient-1', 'ambient-2'] }, deliveryMode: 'digest' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'acked' }) }),
    );
  });

  test('a webhook URL the guard refuses gets no request, and the event is not acked', async () => {
    // The real guard runs here (no override): the address is link-local.
    // Fail instead of connecting, so even a broken guard cannot open a socket here.
    const noNetwork = () => { throw new Error('no network in refusal tests'); };
    const httpSpy = jest.spyOn(http, 'request').mockImplementation(noNetwork);
    const httpsSpy = jest.spyOn(https, 'request').mockImplementation(noNetwork);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentEvent.create.mockResolvedValue({
      _id: 'evt-r', agentName: 'hookbot', instanceId: 'default', podId: POD_P1,
      type: 'chat.mention', payload: {}, status: 'pending', attempts: 0,
    });
    AgentInstallation.find.mockReturnValue({
      lean: () => Promise.resolve([{
        agentName: 'hookbot',
        config: { runtime: { webhookUrl: 'http://169.254.169.254/latest/meta-data/' } },
      }]),
    });

    await AgentEventService.enqueue({
      agentName: 'hookbot', instanceId: 'default', podId: POD_P1, type: 'chat.mention', payload: {},
    });
    await flush();

    expect(postToPublicAddress).toHaveBeenCalledTimes(1);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(AgentEvent.findByIdAndUpdate.mock.calls.some(([, u]) => u && u.status === 'acked')).toBe(false);
    expect(warn).toHaveBeenCalledWith('[webhook] hookbot delivery failed');
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
        _id: 'evt-n', agentName: 'clerk', instanceId: 'default', podId: POD_P1,
        type: 'task.assigned', payload: {}, status: 'delivered', attempts: 1,
      });
      await AgentEventService.enqueue({
        agentName: 'clerk', instanceId: 'default', podId: POD_P1, type: 'task.assigned', payload: {},
      });
      await flush();
      await flush();
    };

    test('a digest for a native installation remains pending without starting a turn', async () => {
      AgentInstallation.findOne.mockReturnValue({ lean: () => Promise.resolve(nativeInstall) });
      AgentEvent.create.mockResolvedValue({
        _id: 'evt-digest', agentName: 'clerk', instanceId: 'default', podId: POD_P1,
        type: 'message.posted', payload: {}, status: 'pending', deliveryMode: 'digest',
      });

      await AgentEventService.enqueue({
        agentName: 'clerk', instanceId: 'default', podId: POD_P1,
        type: 'message.posted', payload: {}, deliveryMode: 'digest',
      });

      expect(AgentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ deliveryMode: 'digest' }));
      expect(AgentEvent.create.mock.calls[0][0]).not.toHaveProperty('status');
      expect(runAgent).not.toHaveBeenCalled();
    });

    test('a later native wake carries digest context and settles only included rows on success', async () => {
      const digest = { _id: 'evt-d', payload: { username: 'alice', messageId: '42', content: 'daily update' } };
      AgentEvent.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([digest]) }) }) });
      AgentEvent.updateMany.mockResolvedValue({ modifiedCount: 1 });
      runAgent.mockResolvedValue({ status: 'succeeded', runId: 'run-1', totalTurns: 1 });

      await enqueueNative();

      expect(runAgent.mock.calls[0][1].payload.content).toContain('pod conversation: 1 unread');
      expect(runAgent.mock.calls[0][1].payload.content).not.toContain('daily update');
      expect(AgentEvent.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['evt-d'] }, status: 'pending', deliveryMode: 'digest' },
        { $set: { status: 'acked' } },
      );

      jest.clearAllMocks();
      AgentEvent.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([digest]) }) }) });
      runAgent.mockResolvedValue({ status: 'failed' });
      await enqueueNative();
      expect(AgentEvent.updateMany).not.toHaveBeenCalled();

      jest.clearAllMocks();
      AgentEvent.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([digest]) }) }) });
      runAgent.mockResolvedValue({ status: 'succeeded', runId: '', totalTurns: 0 });
      const acknowledge = jest.spyOn(AgentEventService, 'acknowledge').mockResolvedValue({});
      await enqueueNative();
      expect(AgentEvent.updateMany).not.toHaveBeenCalled();
      expect(acknowledge).toHaveBeenCalledWith(
        'evt-n', 'clerk', 'default',
        { outcome: 'no_action', reason: 'native-no-turn' },
        null, 'native',
      );
      acknowledge.mockRestore();
    });

    test('a run that stopped because the agent holds the floor settles as a decline with that reason', async () => {
      AgentEvent.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
      runAgent.mockResolvedValue({ status: 'succeeded', runId: 'run-1', totalTurns: 2, noActionReason: 'consecutive_run_cap' });
      const acknowledge = jest.spyOn(AgentEventService, 'acknowledge').mockResolvedValue({});
      await enqueueNative();
      expect(acknowledge).toHaveBeenCalledWith(
        'evt-n', 'clerk', 'default',
        { outcome: 'no_action', reason: 'consecutive_run_cap' },
        null, 'native',
      );
      acknowledge.mockRestore();
    });

    test('a podId shaped like a query operator is never looked up or run in-process', async () => {
      AgentInstallation.findOne.mockReturnValue({ lean: () => Promise.resolve(nativeInstall) });
      AgentEvent.create.mockResolvedValue({ _id: 'evt-x', agentName: 'clerk', instanceId: 'default', type: 'chat.mention', payload: {} });
      await AgentEventService.enqueue({
        agentName: 'clerk', instanceId: 'default', podId: { $ne: null }, type: 'chat.mention', payload: {},
      });
      await flush();
      expect(AgentInstallation.findOne).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
    });

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
        _id: 'evt-n', agentName: 'clerk', instanceId: 'default', podId: POD_P1,
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
        _id: 'evt-n', agentName: 'clerk', instanceId: 'default', podId: POD_P1,
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

// ADR-023 amendment A1: a hosted install routes in-process only when it is on
// the native engine AND provisioned. A Durable Object install keeps polling,
// and a stopped native one routes nowhere, as a stopped Durable Object did.
describe('hosted installs route by engine', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const enqueueHosted = async (hosted) => {
    const install = {
      _id: 'inst-h', agentName: 'maya-agent', config: { runtime: { runtimeType: 'hosted' }, ...(hosted ? { hosted } : {}) },
    };
    AgentInstallation.findOne.mockReturnValue({ lean: () => Promise.resolve(install) });
    AgentInstallation.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    runAgent.mockResolvedValue({ status: 'succeeded' });
    AgentEvent.create.mockImplementation(async (doc) => ({ _id: 'evt-h', ...doc }));
    AgentEvent.findOneAndUpdate.mockResolvedValue({ _id: 'evt-h', status: 'acked' });
    await AgentEventService.enqueue({
      agentName: 'maya-agent', instanceId: 'default', podId: POD_P1, type: 'chat.mention', payload: { content: 'hi' },
    });
    await flush();
    await flush();
  };

  // Sprint-review on #2226: pin the runtime-type check itself, in any case,
  // and that nothing else is promoted.
  test.each([
    ['native', true], ['Native', true], [' NATIVE ', false], ['webhook', false],
  ])('a %j runtime type routes in-process: %s', async (runtimeType, inProcess) => {
    const install = { _id: 'inst-n', agentName: 'maya-agent', config: { runtime: { runtimeType } } };
    AgentInstallation.findOne.mockReturnValue({ lean: () => Promise.resolve(install) });
    AgentInstallation.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    runAgent.mockResolvedValue({ status: 'succeeded' });
    AgentEvent.create.mockImplementation(async (doc) => ({ _id: 'evt-n', ...doc }));
    AgentEvent.findOneAndUpdate.mockResolvedValue({ _id: 'evt-n', status: 'acked' });
    await AgentEventService.enqueue({
      agentName: 'maya-agent', instanceId: 'default', podId: POD_P1, type: 'chat.mention', payload: { content: 'hi' },
    });
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(inProcess ? 1 : 0);
  });

  test('a provisioned native-engine install runs in-process, claimed at creation', async () => {
    await enqueueHosted({ engine: 'native', provisionedAt: new Date() });
    expect(AgentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered', attempts: 1 }));
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['on the Durable Object', undefined],
    ['stopped on the native engine', { engine: 'native', provisionedAt: null }],
  ])('an install %s is queued for a poller and never run in-process', async (_label, hosted) => {
    await enqueueHosted(hosted);
    expect(AgentEvent.create).toHaveBeenCalledWith(expect.not.objectContaining({ status: 'delivered' }));
    expect(runAgent).not.toHaveBeenCalled();
  });
});
