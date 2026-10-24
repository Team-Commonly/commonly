const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const AgentEvent = require('../../../models/AgentEvent');
const AgentEventService = require('../../../services/agentEventService');

describe('live inbox delivery renewal', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  const delivery = async (fields = {}) => {
    const row = { _id: new mongoose.Types.ObjectId(), agentName: 'wren', instanceId: 'default',
      podId: new mongoose.Types.ObjectId(), type: 'chat.mention', status: 'delivered', attempts: 1,
      deliveryNonce: 'current-nonce', deliveredAt: new Date('2026-01-01'), createdAt: new Date(), ...fields };
    await AgentEvent.collection.insertOne(row);
    return row;
  };

  test('extends only current delivery time, without acking or spending another attempt', async () => {
    const row = await delivery();
    expect(await AgentEventService.renewDelivery(String(row._id), 'Wren', 'default', 'current-nonce')).toBe(true);
    const after = await AgentEvent.findById(row._id).lean();
    expect(after.status).toBe('delivered');
    expect(after.deliveryNonce).toBe('current-nonce');
    expect(after.attempts).toBe(1);
    expect(after.deliveredAt.getTime()).toBeGreaterThan(row.deliveredAt.getTime());
  });

  test('GC requeues only two unfinished events after three durable checkpoints', async () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) rows.push(await delivery());
    for (const row of rows.slice(0, 3)) {
      expect(await AgentEventService.acknowledge(String(row._id), 'wren', 'default',
        { outcome: 'acknowledged', reason: 'handled-checkpoint' }, 'current-nonce', 'mcp')).not.toBeNull();
    }
    await AgentEventService.garbageCollect();
    const pending = await AgentEvent.find({ status: 'pending' }).lean();
    expect(pending.map((row) => String(row._id)).sort()).toEqual(rows.slice(3).map((row) => String(row._id)).sort());
    expect(await AgentEvent.countDocuments({ status: 'acked' })).toBe(3);
  });

  test('a renewed live delivery survives the actual stale-delivery GC', async () => {
    const row = await delivery();
    await AgentEventService.renewDelivery(String(row._id), 'wren', 'default', 'current-nonce');
    await AgentEventService.garbageCollect();
    expect((await AgentEvent.findById(row._id).lean()).status).toBe('delivered');
  });

  test.each([
    ['other-seat', 'default', 'current-nonce'], ['wren', 'another-instance', 'current-nonce'],
    ['wren', 'default', 'old-nonce'], ['wren', 'default', ''],
  ])('refuses wrong identity or nonce (%s/%s/%s)', async (agent, instance, nonce) => {
    const row = await delivery();
    expect(await AgentEventService.renewDelivery(String(row._id), agent, instance, nonce)).toBe(false);
    expect((await AgentEvent.findById(row._id).lean()).deliveredAt).toEqual(row.deliveredAt);
  });

  test.each(['pending', 'acked', 'failed'])('does not revive a %s event', async (status) => {
    const row = await delivery({ status });
    expect(await AgentEventService.renewDelivery(String(row._id), 'wren', 'default', 'current-nonce')).toBe(false);
    expect((await AgentEvent.findById(row._id).lean()).status).toBe(status);
  });
});
