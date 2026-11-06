// F189/F182: a runner that stops while it holds claimed events hands them
// back, so its replacement gets them on the next poll instead of after the
// 10–20 minute requeue sweep, up to a redelivery ceiling that still retires a
// poison event.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const AgentEvent = require('../../../models/AgentEvent');
const AgentEventService = require('../../../services/agentEventService');

describe('releasing a held delivery back to pending', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  const podId = new mongoose.Types.ObjectId();
  const delivery = async (fields = {}) => {
    const row = { _id: new mongoose.Types.ObjectId(), agentName: 'wren', instanceId: 'default',
      podId, type: 'chat.mention', status: 'delivered', attempts: 1, payload: { content: 'hi @wren' },
      deliveryNonce: 'current-nonce', deliveredAt: new Date(), createdAt: new Date(), ...fields };
    await AgentEvent.collection.insertOne(row);
    return row;
  };

  test('returns the row to pending with its nonce cleared, keeping the attempt count', async () => {
    const row = await delivery();
    expect(await AgentEventService.releaseDelivery(String(row._id), 'Wren', 'default', 'current-nonce')).toBe('released');
    const after = await AgentEvent.findById(row._id).lean();
    expect(after.status).toBe('pending');
    expect(after.deliveryNonce).toBeNull();
    expect(after.deliveredAt).toBeNull();
    // attempts counts deliveries; a hand-back is not a delivery and refunds nothing.
    expect(after.attempts).toBe(1);
  });

  test('the next poll claims a released event at once, under a new nonce', async () => {
    const row = await delivery();
    await AgentEventService.releaseDelivery(String(row._id), 'wren', 'default', 'current-nonce');
    const [claimed] = await AgentEventService.list({ agentName: 'wren', instanceId: 'default', limit: 10 });
    expect(String(claimed._id)).toBe(String(row._id));
    expect(claimed.payload.deliveryId).toEqual(expect.any(String));
    expect(claimed.payload.deliveryId).not.toBe('current-nonce');
    // The released runner's nonce can no longer ack it, so it is answered once.
    expect(await AgentEventService.acknowledge(String(row._id), 'wren', 'default',
      { outcome: 'posted' }, 'current-nonce', 'cli')).toBeNull();
  });

  // The ceiling is twice the requeue cap (3 by default): six deliveries.
  test('below the redelivery ceiling, a released event is redelivered and not retired', async () => {
    // Restarts each claimed and lost this mention: attempts is past the
    // requeue cap but under the ceiling. Released, it waits as pending.
    const row = await delivery({ attempts: 5, deliveredAt: new Date(Date.now() - 60 * 60 * 1000) });
    expect(await AgentEventService.releaseDelivery(String(row._id), 'wren', 'default', 'current-nonce')).toBe('released');
    const gc = await AgentEventService.garbageCollect();
    expect(gc.expiredDelivered).toBe(0);
    expect((await AgentEvent.findById(row._id).lean()).status).toBe('pending');
    const page = await AgentEventService.list({ agentName: 'wren', instanceId: 'default', limit: 10 });
    expect(page.map((event) => String(event._id))).toEqual([String(row._id)]);
  });

  test('at the redelivery ceiling a release is refused, and the sweep retires the event', async () => {
    // A poison event, or a turn POSTing its own deliveryId, cannot loop
    // through release forever: every lap is a claim, and claims raise attempts.
    const row = await delivery({ attempts: 6, deliveredAt: new Date(Date.now() - 60 * 60 * 1000) });
    expect(await AgentEventService.releaseDelivery(String(row._id), 'wren', 'default', 'current-nonce')).toBe('at_ceiling');
    const held = await AgentEvent.findById(row._id).lean();
    expect(held.status).toBe('delivered');
    expect(held.deliveryNonce).toBe('current-nonce');
    await AgentEventService.garbageCollect();
    expect((await AgentEvent.findById(row._id).lean()).status).toBe('failed');
  });

  test('the ceiling follows AGENT_EVENT_REQUEUE_MAX_ATTEMPTS', async () => {
    const previous = process.env.AGENT_EVENT_REQUEUE_MAX_ATTEMPTS;
    process.env.AGENT_EVENT_REQUEUE_MAX_ATTEMPTS = '2';
    try {
      const under = await delivery({ attempts: 3 });
      const at = await delivery({ attempts: 4 });
      expect(await AgentEventService.releaseDelivery(String(under._id), 'wren', 'default', 'current-nonce')).toBe('released');
      expect(await AgentEventService.releaseDelivery(String(at._id), 'wren', 'default', 'current-nonce')).toBe('at_ceiling');
    } finally {
      if (previous === undefined) delete process.env.AGENT_EVENT_REQUEUE_MAX_ATTEMPTS;
      else process.env.AGENT_EVENT_REQUEUE_MAX_ATTEMPTS = previous;
    }
  });

  test.each([
    ['other-seat', 'default', 'current-nonce'], ['wren', 'another-instance', 'current-nonce'],
    ['wren', 'default', 'old-nonce'], ['wren', 'default', ''],
  ])('refuses wrong identity or nonce (%s/%s/%s)', async (agent, instance, nonce) => {
    const row = await delivery();
    expect(await AgentEventService.releaseDelivery(String(row._id), agent, instance, nonce)).toBe('not_held');
    const after = await AgentEvent.findById(row._id).lean();
    expect(after.status).toBe('delivered');
    expect(after.deliveryNonce).toBe('current-nonce');
  });

  test.each(['pending', 'acked', 'failed'])('does not touch a %s event', async (status) => {
    const row = await delivery({ status });
    expect(await AgentEventService.releaseDelivery(String(row._id), 'wren', 'default', 'current-nonce')).toBe('not_held');
    expect((await AgentEvent.findById(row._id).lean()).status).toBe(status);
  });
});
