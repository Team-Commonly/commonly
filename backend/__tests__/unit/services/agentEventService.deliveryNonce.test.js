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
let AgentEventService;

const AGENT = 'pixel';
const INSTANCE = 'default';
const POD_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentEvent = require('../../../models/AgentEvent');
  AgentMemory = require('../../../models/AgentMemory');
  AgentEventService = require('../../../services/agentEventService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AgentEvent.deleteMany({});
  await AgentMemory.deleteMany({});
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
