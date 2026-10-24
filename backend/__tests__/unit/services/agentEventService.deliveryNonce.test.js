// ADR-026 D6 — the delivery nonce, pinned against mongodb-memory-server.
//
// The race this exists for, from the code as it stood: `acknowledge` matched
// on {_id, agentName, instanceId, status ∈ {pending, delivered}} and nothing
// identifying WHICH delivery. So:
//
//   1. child A claims E                    → delivered, attempts 1
//   2. A hangs; garbageCollect requeues E   → pending, deliveredAt null
//   3. child B claims E                     → attempts 2, starts the turn
//   4. A wakes and acks                     → E goes terminal on A's delivery
//                                             while B is mid-turn
//
// Both children ran the turn, and the lastSeenRevision bump used A's snapshot
// rather than B's. Daemon restart/upgrade (ADR-026) makes step 2-4 routine
// rather than exotic, which is why this lands before the supervisor does.
//
// The suite is written as a MUTATION test: delete the `deliveryNonce` clause
// from acknowledge's filter and `refuses the superseded child's late ack`
// flips to accepted. The revision assertion is the subtler half — a fix that
// rejects the stale ack but leaves A's memoryRevisionAtDelivery in place
// still advances the agent's read-checkpoint to the wrong snapshot.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../services/agentMemoryService', () => ({
  buildMemoryDigestBundle: jest.fn(() => ({})),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  getAgentSessionSizes: jest.fn(),
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(() => 'acct'),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
}));
jest.mock('../../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));

let mongod;
let AgentEvent;
let AgentMemory;
let AgentDigestState;
let AgentEventService;

const AGENT = 'pixel';
const INSTANCE = 'default';
const POD_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentEvent = require('../../../models/AgentEvent');
  AgentMemory = require('../../../models/AgentMemory');
  AgentDigestState = require('../../../models/AgentDigestState');
  AgentEventService = require('../../../services/agentEventService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AgentEvent.deleteMany({});
  await AgentMemory.deleteMany({});
  await AgentDigestState.deleteMany({});
});

describe('legacy ambient digest bridge', () => {
  test('a push hint does not consume durable inbox state before the reconciling poll', async () => {
    const ws = require('../../../services/agentWebSocketService');
    const push = jest.spyOn(ws, 'pushEvent').mockReturnValue(true);
    const digest = await AgentEventService.enqueue({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest',
      payload: { username: 'Alice', content: 'context' },
    });
    const wake = await AgentEventService.enqueue({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'chat.mention', payload: { content: 'question' },
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0][0]._id)).toBe(String(wake._id));
    expect((await AgentEvent.findById(digest._id).lean()).status).toBe('pending');
    expect((await AgentEvent.findById(wake._id).lean()).status).toBe('pending');

    const page = await AgentEventService.listInboxPage({
      agentName: AGENT, instanceId: INSTANCE, podIds: [POD_ID], limit: 10,
    });
    expect(page.events.map((item) => String(item._id))).toEqual([String(wake._id), String(digest._id)]);
    expect((await AgentEvent.findById(wake._id).lean()).attempts).toBe(1);
    expect((await AgentEvent.findById(digest._id).lean()).attempts).toBe(0);
    expect((await AgentEventService.listInboxPage({
      agentName: AGENT, instanceId: INSTANCE, podIds: [POD_ID], limit: 10,
    })).events).toEqual([]);
    push.mockRestore();
  });

  test('a poll after pod access is removed cannot drain a queued wake or digest', async () => {
    const digest = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest', payload: { content: 'private update' },
    });
    const wake = await seedEvent();

    expect(await AgentEventService.listInboxPage({
      agentName: AGENT, instanceId: INSTANCE, podIds: [],
    })).toEqual({ events: [], inboxCount: 0 });
    expect(await AgentEventService.list({
      agentName: AGENT, instanceId: INSTANCE, podIds: [],
    })).toEqual([]);
    expect((await AgentEvent.findById(wake._id).lean()).status).toBe('pending');
    expect((await AgentEvent.findById(digest._id).lean()).status).toBe('pending');
  });

  test('a legacy poll carries the pending digest on its wake and settles it after ack', async () => {
    const ambient = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest',
      payload: { username: 'Alice', messageId: '42', content: 'ambient note' },
    });
    const wake = await seedEvent();
    await AgentEvent.updateOne({ _id: wake._id }, { $set: { payload: { content: 'question' } } });

    const [delivered] = await AgentEventService.list({ agentName: AGENT, instanceId: INSTANCE });
    expect(String(delivered._id)).toBe(String(wake._id));
    expect(delivered.payload.digestSummary).toContain('pod conversation: 1 unread');
    expect(delivered.payload.digestSummary).not.toContain('ambient note');
    expect(delivered.payload.content).toContain('pod conversation: 1 unread');
    expect(delivered.payload.content).not.toContain('ambient note');
    expect((await AgentEvent.findById(ambient._id).lean()).status).toBe('pending');

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'no_action' }, delivered.payload.deliveryId);
    expect((await AgentEvent.findById(ambient._id).lean()).status).toBe('acked');
  });

  test('a failed legacy wake leaves its digest unread for a later wake', async () => {
    const ambient = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest', payload: { content: 'later' },
    });
    const wake = await seedEvent();
    const [delivered] = await AgentEventService.list({ agentName: AGENT, instanceId: INSTANCE });
    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'error' }, delivered.payload.deliveryId);
    expect((await AgentEvent.findById(ambient._id).lean()).status).toBe('pending');
  });

  test('a legacy wake without content still exposes digest to the consumer', async () => {
    await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest',
      payload: { username: 'Alice', content: 'ambient note' },
    });
    await seedEvent(); // payload.text only; older consumers read payload.content.

    const [delivered] = await AgentEventService.list({ agentName: AGENT, instanceId: INSTANCE });
    expect(delivered.payload.content).toContain('pod conversation: 1 unread');
    expect(delivered.payload.content).not.toContain('ambient note');
  });

  test('a claim stand-down does not consume raw or folded digest', async () => {
    const ambient = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest', payload: { content: 'later' },
    });
    await AgentDigestState.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      unreadCount: 2, revision: 1, lastEventIds: ['old-1', 'old-2'],
    });
    const wake = await seedEvent();
    const [delivered] = await AgentEventService.list({ agentName: AGENT, instanceId: INSTANCE });
    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'no_action', reason: 'claim-held' }, delivered.payload.deliveryId);

    expect((await AgentEvent.findById(ambient._id).lean()).status).toBe('pending');
    expect((await AgentDigestState.findOne({ agentName: AGENT, podId: POD_ID }).lean()).unreadCount).toBe(2);
  });

  test('repeated refused wakes do not exhaust the digest delivery cap', async () => {
    const digest = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest', payload: { content: 'still unread' },
    });
    for (let index = 0; index < 4; index += 1) {
      const wake = await seedEvent();
      const page = await AgentEventService.listInboxPage({
        agentName: AGENT, instanceId: INSTANCE, podIds: [POD_ID], limit: 10,
      });
      expect(page.events.map((event) => String(event._id)))
        .toEqual([String(wake._id), String(digest._id)]);
      await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
        { outcome: 'no_action', reason: 'claim-held' }, page.events[0].deliveryNonce);
      await AgentEvent.updateOne({ _id: digest._id }, {
        $set: { status: 'pending', deliveryNonce: null, deliveredAt: null },
      });
    }
    expect((await AgentEvent.findById(digest._id).lean()).attempts).toBe(0);
    expect((await AgentEvent.findById(digest._id).lean()).status).toBe('pending');
  });

  test('a legacy wake carries a folded count and clears only the revision it showed', async () => {
    await AgentDigestState.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      unreadCount: 3, revision: 1, lastEventIds: ['old-1', 'old-2', 'old-3'],
    });
    const wake = await seedEvent();
    const [delivered] = await AgentEventService.list({ agentName: AGENT, instanceId: INSTANCE });
    expect(delivered.payload.digestSummary).toContain('older pod activity: 3 unread');
    await AgentDigestState.updateOne({ agentName: AGENT, podId: POD_ID },
      { $inc: { unreadCount: 1, revision: 1 } });

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'no_action' }, delivered.payload.deliveryId);
    expect((await AgentDigestState.findOne({ agentName: AGENT, podId: POD_ID }).lean()).unreadCount).toBe(4);
  });
});

const seedEvent = () => AgentEvent.create({
  agentName: AGENT,
  instanceId: INSTANCE,
  podId: POD_ID,
  type: 'chat.mention',
  payload: { text: 'hello' },
  status: 'pending',
});

// One claim through the real code path, returning the nonce the driver would
// have been handed in its payload.
const claim = async () => {
  const [delivered] = await AgentEventService.list({
    agentName: AGENT,
    instanceId: INSTANCE,
    limit: 5,
  });
  return delivered;
};

// Age the delivery past the requeue threshold and run the real pass, rather
// than hand-writing `status: 'pending'` — the point is that the REQUEUE
// invalidates, so a test that sets the field itself would pass against a
// requeue that forgot to.
const requeue = async (eventId) => {
  await AgentEvent.updateOne(
    { _id: eventId },
    { $set: { deliveredAt: new Date(Date.now() - 60 * 60 * 1000) } },
  );
  await AgentEventService.garbageCollect({ requeueDeliveredMinutes: 10 });
};

describe('delivery nonce', () => {
  test('the claim mints a nonce and hands it to the driver as deliveryId', async () => {
    const event = await seedEvent();
    const delivered = await claim();

    expect(delivered).toBeTruthy();
    expect(delivered.payload.deliveryId).toEqual(expect.any(String));
    expect(delivered.payload.deliveryId).toHaveLength(32);

    const stored = await AgentEvent.findById(event._id).lean();
    expect(stored.status).toBe('delivered');
    expect(stored.deliveryNonce).toBe(delivered.payload.deliveryId);
  });

  test('the requeue clears it, and the next claim mints a different one', async () => {
    const event = await seedEvent();
    const first = await claim();

    await requeue(event._id);

    const requeued = await AgentEvent.findById(event._id).lean();
    expect(requeued.status).toBe('pending');
    // The invalidation itself. Without this line in garbageCollect, the stale
    // child's nonce still matches and the whole gate is decorative.
    expect(requeued.deliveryNonce).toBeNull();

    const second = await claim();
    expect(second.payload.deliveryId).not.toBe(first.payload.deliveryId);
  });

  test('refuses the superseded child\'s late ack, and keeps the new delivery live', async () => {
    const event = await seedEvent();
    const childA = await claim();

    await requeue(event._id);
    const childB = await claim();
    expect(childB.payload.deliveryId).not.toBe(childA.payload.deliveryId);

    const staleAck = await AgentEventService.acknowledge(
      event._id,
      AGENT,
      INSTANCE,
      { outcome: 'no_action' },
      childA.payload.deliveryId,
    );

    expect(staleAck).toBeNull();
    const afterStale = await AgentEvent.findById(event._id).lean();
    // B is still mid-turn: its delivery must survive A's ack untouched.
    expect(afterStale.status).toBe('delivered');
    expect(afterStale.deliveryNonce).toBe(childB.payload.deliveryId);
    // A's outcome must not be recorded as the event's result.
    expect(afterStale.delivery?.outcome).toBeUndefined();
  });

  test('the holding child\'s ack lands, and advances the checkpoint to ITS snapshot', async () => {
    await AgentMemory.create({
      agentName: AGENT,
      instanceId: INSTANCE,
      revision: 7,
      lastSeenRevision: 1,
    });

    const event = await seedEvent();
    const childA = await claim();

    // Memory moves on between the two deliveries, so A's snapshot and B's are
    // distinguishable — that difference is what the last assertion reads.
    await AgentMemory.updateOne(
      { agentName: AGENT, instanceId: INSTANCE },
      { $set: { revision: 9 } },
    );

    await requeue(event._id);
    const childB = await claim();

    const acked = await AgentEventService.acknowledge(
      event._id,
      AGENT,
      INSTANCE,
      { outcome: 'posted' },
      childB.payload.deliveryId,
    );

    expect(acked).toBeTruthy();
    const stored = await AgentEvent.findById(event._id).lean();
    expect(stored.status).toBe('acked');
    expect(stored.delivery.outcome).toBe('posted');
    // Terminal: nothing left for a later ack to match.
    expect(stored.deliveryNonce).toBeNull();

    const memory = await AgentMemory.findOne({ agentName: AGENT, instanceId: INSTANCE }).lean();
    // 9, not 7 — a fix that only rejects the stale ack would leave the
    // checkpoint on A's snapshot and corrupt the agent's memory read window.
    expect(memory.lastSeenRevision).toBe(9);
    expect(childA.payload.deliveryId).not.toBe(childB.payload.deliveryId);
  });

  test('an ack with no deliveryId still lands — the pre-D6 fleet keeps working', async () => {
    const event = await seedEvent();
    await claim();

    const acked = await AgentEventService.acknowledge(
      event._id,
      AGENT,
      INSTANCE,
      { outcome: 'acknowledged' },
    );

    expect(acked).toBeTruthy();
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('acked');
  });

  test('an unguessable nonce also stops acking a delivery you never received', async () => {
    const event = await seedEvent();
    await claim();

    const forged = await AgentEventService.acknowledge(
      event._id,
      AGENT,
      INSTANCE,
      { outcome: 'no_action' },
      'f'.repeat(32),
    );

    expect(forged).toBeNull();
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
  });

  test('retires an exhausted event and delivers only a newly enqueued event', async () => {
    // This is deliberately stateful: the query-shape lifecycle tests prove
    // that the predicates are disjoint, but only a real store can prove that
    // an exhausted row is no longer listed while a fresh pending row is.
    const exhausted = await seedEvent();

    const first = await claim();
    expect(String(first._id)).toBe(String(exhausted._id));
    await requeue(exhausted._id);

    const second = await claim();
    expect(String(second._id)).toBe(String(exhausted._id));
    await requeue(exhausted._id);

    const third = await claim();
    expect(String(third._id)).toBe(String(exhausted._id));
    expect(third.attempts).toBe(3);

    // Age only the third delivery; invoking GC now must take the cap-exhausted
    // branch rather than requeueing it for a fourth delivery.
    await AgentEvent.updateOne(
      { _id: exhausted._id },
      { $set: { deliveredAt: new Date(Date.now() - 60 * 60 * 1000) } },
    );
    const collected = await AgentEventService.garbageCollect({
      requeueDeliveredMinutes: 10,
      requeueMaxAttempts: 3,
    });

    expect(collected.expiredDelivered).toBe(1);
    expect((await AgentEvent.findById(exhausted._id).lean()).status).toBe('failed');
    expect(await AgentEventService.list({
      agentName: AGENT,
      instanceId: INSTANCE,
      limit: 5,
    })).toHaveLength(0);

    const fresh = await AgentEventService.enqueue({
      agentName: AGENT,
      instanceId: INSTANCE,
      podId: POD_ID,
      type: 'chat.mention',
      payload: { text: 'fresh event' },
    });
    const deliverable = await AgentEventService.list({
      agentName: AGENT,
      instanceId: INSTANCE,
      limit: 5,
    });

    expect(deliverable).toHaveLength(1);
    expect(String(deliverable[0]._id)).toBe(String(fresh._id));
    expect(deliverable[0].attempts).toBe(1);
    expect(deliverable[0].payload.text).toBe('fresh event');
  });
});

describe('isSupersededDelivery — telling "replaced" apart from "gone"', () => {
  test('true when the event is live under a newer nonce', async () => {
    const event = await seedEvent();
    const childA = await claim();
    await requeue(event._id);
    await claim();

    await expect(AgentEventService.isSupersededDelivery(
      event._id, AGENT, INSTANCE, childA.payload.deliveryId,
    )).resolves.toBe(true);
  });

  test('false once the event is terminal — that is idempotent success, not supersession', async () => {
    const event = await seedEvent();
    const child = await claim();
    await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'posted' }, child.payload.deliveryId,
    );

    await expect(AgentEventService.isSupersededDelivery(
      event._id, AGENT, INSTANCE, child.payload.deliveryId,
    )).resolves.toBe(false);
  });

  test('false for a caller that presented no nonce at all', async () => {
    const event = await seedEvent();
    await claim();

    await expect(AgentEventService.isSupersededDelivery(
      event._id, AGENT, INSTANCE, null,
    )).resolves.toBe(false);
  });
});

describe('markPosted annotates the delivery in flight, it does not start a new one', () => {
  test('an already-acked event is not returned to delivered', async () => {
    const event = await seedEvent();
    const child = await claim();
    await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'no_action' }, child.payload.deliveryId,
    );

    await AgentEventService.markPosted(String(event._id), AGENT, INSTANCE, { messageId: 'm1' });

    const stored = await AgentEvent.findById(event._id).lean();
    // Without the status gate this row went back to 'delivered' with a fresh
    // deliveredAt — straight into the requeue population, re-delivering work
    // that was already finished.
    expect(stored.status).toBe('acked');
  });

  test('a requeued event is not flipped back to delivered by a stale post', async () => {
    const event = await seedEvent();
    await claim();
    await requeue(event._id);

    // The stale child posts after losing its delivery. Under the first,
    // looser gate ($ne: 'acked') this flipped pending → delivered with a null
    // nonce, and the next claim then saw nothing — the event was hidden for
    // another full requeue window by a child that no longer owned it.
    await AgentEventService.markPosted(String(event._id), AGENT, INSTANCE, { messageId: 'm-stale' });

    const stored = await AgentEvent.findById(event._id).lean();
    expect(stored.status).toBe('pending');
    const replacement = await claim();
    expect(replacement).toBeTruthy();
    expect(replacement.payload.deliveryId).toEqual(expect.any(String));
  });

  test('a failed event retired by the cap is not resurrected by a post', async () => {
    const event = await seedEvent();
    await AgentEvent.updateOne(
      { _id: event._id },
      { $set: { status: 'failed', error: 'retired', deliveryNonce: null } },
    );

    await AgentEventService.markPosted(String(event._id), AGENT, INSTANCE, { messageId: 'm-late' });

    expect((await AgentEvent.findById(event._id).lean()).status).toBe('failed');
  });

  test('it leaves the holder\'s nonce intact, so the holder can still ack', async () => {
    const event = await seedEvent();
    const child = await claim();

    await AgentEventService.markPosted(String(event._id), AGENT, INSTANCE, { messageId: 'm1' });

    const stored = await AgentEvent.findById(event._id).lean();
    expect(stored.deliveryNonce).toBe(child.payload.deliveryId);

    const acked = await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'posted' }, child.payload.deliveryId,
    );
    expect(acked).toBeTruthy();
  });
});

describe('the Phase A migration counter', () => {
  test('counts nonce-bearing and nonce-less acks apart', async () => {
    const before = AgentEventService.getAckNonceStats();

    const withNonce = await seedEvent();
    const child = await claim();
    await AgentEventService.acknowledge(
      withNonce._id, AGENT, INSTANCE, { outcome: 'no_action' }, child.payload.deliveryId,
    );

    const withoutNonce = await seedEvent();
    await claim();
    await AgentEventService.acknowledge(
      withoutNonce._id, AGENT, INSTANCE, { outcome: 'no_action' },
    );

    const after = AgentEventService.getAckNonceStats();
    expect(after.withNonce - before.withNonce).toBe(1);
    // This is the number Phase B is gated on. A counter nobody can read is a
    // migration plan with no exit condition.
    expect(after.withoutNonce - before.withoutNonce).toBe(1);
  });
});

describe('the native path carries its own delivery nonce', () => {
  const { runAgent } = require('../../../services/nativeRuntimeService');
  const { AgentInstallation } = require('../../../models/AgentRegistry');

  // enqueue() routes to the native runtime when the installation says so; the
  // event is then born 'delivered' and the settle handlers are its ack.
  const nativeInstall = {
    _id: new mongoose.Types.ObjectId(),
    agentName: AGENT,
    instanceId: INSTANCE,
    podId: POD_ID,
    status: 'active',
    config: { runtime: { runtimeType: 'native' } },
  };

  afterEach(() => { jest.restoreAllMocks(); });

  test('a native run that outlives the requeue does not terminate its replacement', async () => {
    let settle;
    runAgent.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const findOne = jest.spyOn(AgentInstallation, 'findOne').mockReturnValue({
      lean: () => Promise.resolve(nativeInstall),
    });

    const event = await AgentEventService.enqueue({
      agentName: AGENT,
      instanceId: INSTANCE,
      podId: POD_ID,
      type: 'chat.mention',
      payload: { text: 'hi' },
    });

    const born = await AgentEvent.findById(event._id).lean();
    expect(born.status).toBe('delivered');
    // Minting is not enough — the settle handler has to CARRY it.
    expect(born.deliveryNonce).toEqual(expect.any(String));

    // By the sweep the agent no longer runs in-process (TASK-264 re-runs the
    // ones that still do; see the next test), so the requeue hands the event
    // to an external poller.
    findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await requeue(event._id);
    const replacement = await claim();
    expect(replacement.payload.deliveryId).not.toBe(born.deliveryNonce);

    // The slow native run finally finishes and acks.
    settle('done');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const after = await AgentEvent.findById(event._id).lean();
    expect(after.status).toBe('delivered');
    expect(after.deliveryNonce).toBe(replacement.payload.deliveryId);
  });
});

// TASK-264: a native turn that died with its process is re-run in-process by
// the sweep, under a fresh nonce, instead of being requeued to a queue no
// native agent polls. The dead (or merely slow) run can still not end it.
describe('the sweep re-runs a stuck in-process event', () => {
  const { runAgent } = require('../../../services/nativeRuntimeService');
  const { AgentInstallation } = require('../../../models/AgentRegistry');
  const AgentRun = require('../../../models/AgentRun');
  const nativeInstall = {
    _id: new mongoose.Types.ObjectId(),
    agentName: AGENT,
    instanceId: INSTANCE,
    podId: POD_ID,
    status: 'active',
    config: { runtime: { runtimeType: 'native' } },
  };

  afterEach(() => { jest.restoreAllMocks(); });

  const enqueueStuck = async () => {
    const settles = [];
    runAgent.mockImplementation(() => new Promise((resolve) => { settles.push(resolve); }));
    jest.spyOn(AgentInstallation, 'findOne').mockReturnValue({ lean: () => Promise.resolve(nativeInstall) });
    const event = await AgentEventService.enqueue({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID, type: 'chat.mention', payload: { text: 'hi' },
    });
    // Native dispatch now gathers pending ambient digest before calling the
    // runner. Wait for that asynchronous read so it cannot leak into the next
    // test or make an immediate runAgent assertion race the database.
    for (let i = 0; i < 50 && runAgent.mock.calls.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const born = await AgentEvent.findById(event._id).lean();
    return { event, born, settles };
  };

  test('re-runs it under a fresh nonce, and the dead run cannot end the new delivery', async () => {
    const { event, born, settles } = await enqueueStuck();
    await requeue(event._id);

    const rerun = await AgentEvent.findById(event._id).lean();
    expect(rerun.status).toBe('delivered');
    expect(rerun.deliveryNonce).toEqual(expect.any(String));
    expect(rerun.deliveryNonce).not.toBe(born.deliveryNonce);
    expect(rerun.attempts).toBe(born.attempts + 1);
    expect(runAgent).toHaveBeenCalledTimes(2);

    settles[0]('done'); // the dead turn's late settle
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');

    settles[1]('done'); // the re-run's settle
    let status;
    for (let i = 0; i < 50 && status !== 'acked'; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
      // eslint-disable-next-line no-await-in-loop
      ({ status } = await AgentEvent.findById(event._id).lean());
    }
    expect(status).toBe('acked');
  });

  test('two sweeps racing (two replicas) re-run it once', async () => {
    const { event } = await enqueueStuck();
    await AgentEvent.updateOne({ _id: event._id }, { $set: { deliveredAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const threshold = new Date(Date.now() - 10 * 60 * 1000);
    const results = await Promise.all([
      AgentEventService.redispatchStuckInProcess(threshold, 3),
      AgentEventService.redispatchStuckInProcess(threshold, 3),
    ]);

    for (let i = 0; i < 50 && runAgent.mock.calls.length < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(results.reduce((sum, r) => sum + r.redispatched, 0)).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(2); // the original turn plus one re-run
  });

  test('acks instead of answering twice when the run had already succeeded', async () => {
    const { event } = await enqueueStuck();
    jest.spyOn(AgentRun, 'exists').mockResolvedValue({ _id: 'run-1' });
    await requeue(event._id);

    expect((await AgentEvent.findById(event._id).lean()).status).toBe('acked');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('marks a run its process abandoned as interrupted, and leaves live and finished runs alone', async () => {
    const base = { podId: new mongoose.Types.ObjectId(), agentName: AGENT, instanceId: INSTANCE, trigger: 'mention' };
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [abandoned, live, finished] = await AgentRun.create([
      { ...base, status: 'running', startedAt: hourAgo },
      { ...base, status: 'running', startedAt: new Date() },
      { ...base, status: 'succeeded', startedAt: hourAgo },
    ]);
    const result = await AgentEventService.garbageCollect({ requeueDeliveredMinutes: 10 });

    expect(result.interruptedRuns).toBe(1);
    expect((await AgentRun.findById(abandoned._id).lean()).status).toBe('interrupted');
    expect((await AgentRun.findById(live._id).lean()).status).toBe('running');
    expect((await AgentRun.findById(finished._id).lean()).status).toBe('succeeded');
  });

  test('leaves an event at the attempt cap to the expiry pass', async () => {
    const { event } = await enqueueStuck();
    await AgentEvent.updateOne({ _id: event._id }, { $set: { attempts: 3 } });
    await requeue(event._id);

    expect((await AgentEvent.findById(event._id).lean()).status).toBe('failed');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

// TASK-265, Rhea on #2236: enqueue decides routing before the insert, so an
// event enqueued while the hosted migration runs can persist 'pending' after
// the agent became in-process, and nothing polls it. The recurring sweep runs
// it. Real installation rows, so the routing decision is the production one.
describe('the sweep runs a pending event stranded by a move in-process', () => {
  const { runAgent } = require('../../../services/nativeRuntimeService');
  const { AgentInstallation } = require('../../../models/AgentRegistry');
  const OWNER = new mongoose.Types.ObjectId();
  const HOSTED_DO = { runtime: { runtimeType: 'hosted' }, hosted: { provisionedAt: new Date() } };
  const MIGRATED = (state) => ({
    runtime: { runtimeType: 'hosted' },
    hosted: {
      engine: 'native', provisionedAt: new Date(), migratedFrom: 'durable-object', migration: { state, doProvisioned: true },
    },
  });
  const install = (agentName, config, podId = POD_ID) => AgentInstallation.create({
    agentName, instanceId: INSTANCE, podId, version: '1.0.0', status: 'active', installedBy: OWNER, config,
  });
  // createdAt is immutable through Mongoose, so age it on the collection.
  const age = (eventId, ms) => AgentEvent.collection.updateOne(
    { _id: eventId }, { $set: { createdAt: new Date(Date.now() - ms) } },
  );
  const sweep = () => AgentEventService.garbageCollect({ requeueDeliveredMinutes: 10 });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    runAgent.mockReset();
    runAgent.mockResolvedValue({ status: 'succeeded' });
  });
  afterEach(async () => {
    await AgentInstallation.deleteMany({});
    runAgent.mockReset();
  });

  test('the enqueue race: routed to the Durable Object, persisted after the migration finished, then run once', async () => {
    // The turn stays in flight, so the claim the sweep made is what is stored.
    runAgent.mockImplementation(() => new Promise(() => {}));
    const row = await install(AGENT, HOSTED_DO);
    // Routing is decided while the row is still on the Durable Object...
    const event = await AgentEventService.enqueue({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID, type: 'chat.mention', payload: { text: 'hi' },
    });
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
    expect(runAgent).not.toHaveBeenCalled();
    // ...and the migration finishes before anything polls it.
    await AgentInstallation.updateOne({ _id: row._id }, { $set: { config: MIGRATED('done') } });
    await age(event._id, 2 * 60 * 1000);

    const result = await sweep();

    expect(result.rescuedPendingInProcess).toBe(1);
    const ran = await AgentEvent.findById(event._id).lean();
    expect(ran.status).toBe('delivered');
    expect(ran.deliveryNonce).toEqual(expect.any(String));
    expect(ran.attempts).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);

    await sweep();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['an agent still on the Durable Object', HOSTED_DO, 2 * 60 * 1000, 0],
    ['a migration not yet done', MIGRATED('stopped'), 2 * 60 * 1000, 0],
    ['an event under a minute old', MIGRATED('done'), 10 * 1000, 0],
    ['an event at the attempt cap', MIGRATED('done'), 2 * 60 * 1000, 3],
    // Not in-process yet: the migration's own events step owns it, at any age.
    ['a migration not yet done, past half an hour', MIGRATED('stopped'), 31 * 60 * 1000, 0],
  ])('leaves alone %s', async (_label, config, ageMs, attempts) => {
    // A runnable agent elsewhere, so the sweep has targets and its run and
    // close passes both execute; this event must still be left alone.
    await install('runnable-agent', MIGRATED('done'), new mongoose.Types.ObjectId());
    await install(AGENT, config);
    const event = await seedEvent();
    await AgentEvent.updateOne({ _id: event._id }, { $set: { attempts } });
    await age(event._id, ageMs);

    const result = await sweep();

    expect(result.rescuedPendingInProcess).toBe(0);
    expect(result.closedPendingInProcess).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
  });

  // Sprint review on #2236: the 30-minute ceiling was terminal and silent: an
  // event past it was neither run nor closed, so the question vanished with
  // no record. Past the ceiling it is now closed with a reason, never run.
  test.each([
    ['past half an hour', 31 * 60 * 1000, 0],
    ['past half an hour and at the attempt cap', 31 * 60 * 1000, 3],
  ])('closes an in-process agent\'s event %s, with a reason, and does not run it', async (_label, ageMs, attempts) => {
    await install(AGENT, MIGRATED('done'));
    const event = await seedEvent();
    await AgentEvent.updateOne({ _id: event._id }, { $set: { attempts } });
    await age(event._id, ageMs);

    const result = await sweep();

    expect(result).toMatchObject({ rescuedPendingInProcess: 0, closedPendingInProcess: 1 });
    expect(runAgent).not.toHaveBeenCalled();
    const closed = await AgentEvent.findById(event._id).lean();
    expect(closed.status).toBe('failed');
    expect(closed.error).toMatch(/not run within 30 minutes/);
  });

  // Rhea on #2236: the batch cap used to apply before runnability, so 50
  // pending events of an unfinished migration filled every pass and a
  // completed agent's event aged out unrun. Only runnable targets are
  // selected now, so it runs on the first pass and the backlog is untouched.
  test("an unfinished migration's backlog of 50 does not starve a completed agent's event", async () => {
    const OTHER_POD = new mongoose.Types.ObjectId();
    await install('stuck-agent', MIGRATED('stopped'), OTHER_POD);
    await install(AGENT, MIGRATED('done'));
    const backlog = await AgentEvent.create(Array.from({ length: 50 }, () => ({
      agentName: 'stuck-agent', instanceId: INSTANCE, podId: OTHER_POD, type: 'chat.mention', payload: {}, status: 'pending',
    })));
    await AgentEvent.collection.updateMany(
      { _id: { $in: backlog.map((row) => row._id) } },
      { $set: { createdAt: new Date(Date.now() - 3 * 60 * 1000) } },
    );
    const event = await seedEvent();
    await age(event._id, 2 * 60 * 1000);

    const result = await sweep();

    expect(result.rescuedPendingInProcess).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect((await AgentEvent.findById(event._id).lean()).status).not.toBe('pending');
    expect(await AgentEvent.countDocuments({ agentName: 'stuck-agent', status: 'pending', attempts: 0 })).toBe(50);
  });

  // A projection row (an agent-room install with no runtime of its own)
  // routes like its identity's most recent row that has one, in enqueue and in
  // the sweep's targets alike.
  test("runs a stranded event in a projection pod that inherits a completed migration's runtime", async () => {
    const SOURCE_POD = new mongoose.Types.ObjectId();
    await install(AGENT, MIGRATED('done'), SOURCE_POD);
    await install(AGENT, { heartbeat: { enabled: false } });
    const event = await seedEvent();
    await age(event._id, 2 * 60 * 1000);

    const result = await sweep();

    expect(result.rescuedPendingInProcess).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('two sweeps racing (two replicas) run it once', async () => {
    await install(AGENT, MIGRATED('done'));
    const event = await seedEvent();
    await age(event._id, 2 * 60 * 1000);

    const counts = await Promise.all([
      AgentEventService.rescueStrandedPendingInProcess(new Date(), 3),
      AgentEventService.rescueStrandedPendingInProcess(new Date(), 3),
    ]);

    for (let i = 0; i < 50 && runAgent.mock.calls.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(counts[0].rescued + counts[1].rescued).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test("a backlog of external agents' pending events does not crowd it out", async () => {
    await install(AGENT, MIGRATED('done'));
    const backlog = Array.from({ length: 60 }, () => ({
      agentName: 'offline-seat', instanceId: INSTANCE, podId: POD_ID, type: 'chat.mention', payload: {}, status: 'pending',
    }));
    const external = await AgentEvent.create(backlog);
    await AgentEvent.collection.updateMany(
      { _id: { $in: external.map((row) => row._id) } },
      { $set: { createdAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    const event = await seedEvent();
    await age(event._id, 2 * 60 * 1000);

    expect((await AgentEventService.rescueStrandedPendingInProcess(new Date(), 3)).rescued).toBe(1);
    expect((await AgentEvent.findById(event._id).lean()).status).not.toBe('pending');
  });
});

describe('recordFailure is as terminal as an ack, and gated the same way', () => {
  test('a stale runner\'s failure does not retire the replacement\'s delivery', async () => {
    const event = await seedEvent();
    const childA = await claim();
    await requeue(event._id);
    const childB = await claim();

    await AgentEventService.recordFailure(
      String(event._id), AGENT, INSTANCE, 'stale runner blew up', childA.payload.deliveryId,
    );

    const stored = await AgentEvent.findById(event._id).lean();
    expect(stored.status).toBe('delivered');
    expect(stored.deliveryNonce).toBe(childB.payload.deliveryId);
  });
});

describe('recordFailure will not overwrite a terminal event', () => {
  test('a late nonce-less failure leaves an acked event acked', async () => {
    const event = await seedEvent();
    const child = await claim();
    await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'posted' }, child.payload.deliveryId,
    );

    await AgentEventService.recordFailure(String(event._id), AGENT, INSTANCE, 'late boom');

    const stored = await AgentEvent.findById(event._id).lean();
    expect(stored.status).toBe('acked');
    expect(stored.error).toBeUndefined();
  });
});

describe('Phase B has a switch, so the compatibility mode terminates', () => {
  afterEach(() => { delete process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE; });

  test('with the flag set, a nonce-less ack is refused', async () => {
    process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE = 'true';
    const event = await seedEvent();
    await claim();

    const acked = await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'acknowledged' },
    );

    expect(acked).toBeNull();
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
  });

  test('with the flag set, a matching nonce still lands', async () => {
    process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE = 'true';
    const event = await seedEvent();
    const child = await claim();

    const acked = await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'acknowledged' }, child.payload.deliveryId,
    );

    expect(acked).toBeTruthy();
  });
});

describe('Phase B flips per consumer, so a parked path cannot veto it', () => {
  afterEach(() => { delete process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE; });

  test('a listed consumer is enforced while an unlisted one keeps working', async () => {
    process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE = 'ws,cli';

    expect(AgentEventService.isDeliveryNonceRequired('ws')).toBe(true);
    expect(AgentEventService.isDeliveryNonceRequired('cli')).toBe(true);
    // The parked openclaw extension. It must not hold the flip hostage, and
    // it must not break while it is parked.
    expect(AgentEventService.isDeliveryNonceRequired('openclaw')).toBe(false);
    expect(AgentEventService.isDeliveryNonceRequired()).toBe(false);

    const event = await seedEvent();
    await claim();
    const acked = await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'acknowledged' }, null, 'openclaw',
    );
    expect(acked).toBeTruthy();
  });

  test('a listed consumer acking nonce-less is refused', async () => {
    process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE = 'ws,cli';
    const event = await seedEvent();
    await claim();

    const acked = await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'acknowledged' }, null, 'cli',
    );

    expect(acked).toBeNull();
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
  });

  test("`true` still means everyone — the global switch is not lost", async () => {
    process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE = 'true';
    expect(AgentEventService.isDeliveryNonceRequired('openclaw')).toBe(true);
    expect(AgentEventService.isDeliveryNonceRequired()).toBe(true);
  });

  test('the counter attributes nonce-less acks to the consumer that made them', async () => {
    const before = AgentEventService.getAckNonceStats().withoutNonceByConsumer.openclaw || 0;
    const event = await seedEvent();
    await claim();

    await AgentEventService.acknowledge(
      event._id, AGENT, INSTANCE, { outcome: 'acknowledged' }, null, 'openclaw',
    );

    const after = AgentEventService.getAckNonceStats().withoutNonceByConsumer.openclaw || 0;
    // Naming the holdout is what makes a per-consumer flip decidable.
    expect(after - before).toBe(1);
  });
});
