const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const AgentEvent = require('../../../models/AgentEvent');
const AgentDigestState = require('../../../models/AgentDigestState');
const AgentEventService = require('../../../services/agentEventService');
const { foldExpiredDigests, readFoldedDigest, settleFoldedDigest } = require('../../../services/agentDigestFoldService');

const NOW = new Date('2026-10-23T23:00:00.000Z');
const THRESHOLD = new Date(NOW.getTime() - 60 * 60 * 1000);

describe('expired digest fold', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentDigestState.init();
  });
  afterAll(closeMongoDb);
  afterEach(async () => {
    jest.restoreAllMocks();
    await clearMongoDb();
  });

  const seed = async (createdAt, podId) => AgentEvent.collection.insertOne({
    agentName: 'flint', instanceId: 'default', podId,
    type: 'message.posted', deliveryMode: 'digest', status: 'pending',
    attempts: 0, createdAt, updatedAt: createdAt,
  });

  it('retains unread count and last IDs while deleting expired full events', async () => {
    const podId = new mongoose.Types.ObjectId();
    const first = await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    const second = await seed(new Date(NOW.getTime() - 90 * 60 * 1000), podId);
    const recent = await seed(NOW, podId);

    expect(await foldExpiredDigests(THRESHOLD)).toBe(2);
    const state = await AgentDigestState.findOne({ agentName: 'flint', podId }).lean();
    expect(state.unreadCount).toBe(2);
    expect(state.lastEventIds).toEqual([String(first.insertedId), String(second.insertedId)]);
    expect(await AgentEvent.exists({ _id: recent.insertedId })).toBeTruthy();
    expect(await AgentEvent.countDocuments({ podId })).toBe(1);
  });

  it('folds old unacked deliveries and failures before ordinary GC can delete them', async () => {
    const podId = new mongoose.Types.ObjectId();
    const delivered = await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    const failed = await seed(new Date(NOW.getTime() - 90 * 60 * 1000), podId);
    await AgentEvent.collection.updateOne({ _id: delivered.insertedId }, { $set: { status: 'delivered' } });
    await AgentEvent.collection.updateOne({ _id: failed.insertedId }, { $set: { status: 'failed' } });

    expect(await foldExpiredDigests(THRESHOLD)).toBe(2);
    expect((await AgentDigestState.findOne({ agentName: 'flint', podId }).lean()).unreadCount).toBe(2);
  });

  it('does not count a row twice after a crash between state update and delete', async () => {
    const podId = new mongoose.Types.ObjectId();
    const event = await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    const deleteOne = jest.spyOn(AgentEvent, 'deleteOne').mockRejectedValueOnce(new Error('lost connection'));
    await expect(foldExpiredDigests(THRESHOLD)).rejects.toThrow('lost connection');
    deleteOne.mockRestore();
    expect(await AgentEvent.findById(event.insertedId).lean()).toMatchObject({ status: 'folding' });

    expect(await foldExpiredDigests(THRESHOLD)).toBe(1);
    const state = await AgentDigestState.findOne({ agentName: 'flint', podId }).lean();
    expect(state.unreadCount).toBe(1);
    expect(state.lastEventIds).toEqual([String(event.insertedId)]);
  });

  it('counts each expired row once when two GC workers overlap', async () => {
    const podId = new mongoose.Types.ObjectId();
    await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    await seed(new Date(NOW.getTime() - 90 * 60 * 1000), podId);

    const deleted = await Promise.all([foldExpiredDigests(THRESHOLD), foldExpiredDigests(THRESHOLD)]);
    expect(deleted[0] + deleted[1]).toBe(2);
    const state = await AgentDigestState.findOne({ agentName: 'flint', podId }).lean();
    expect(state.unreadCount).toBe(2);
    expect(await AgentEvent.countDocuments({ podId })).toBe(0);
  });

  it('does not advance the cursor past an older row another worker claimed', async () => {
    const podId = new mongoose.Types.ObjectId();
    await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    await seed(new Date(NOW.getTime() - 90 * 60 * 1000), podId);
    const claim = jest.spyOn(AgentEvent, 'findOneAndUpdate').mockResolvedValueOnce(null);

    expect(await foldExpiredDigests(THRESHOLD)).toBe(0);
    expect(await AgentDigestState.findOne({ agentName: 'flint', podId })).toBeNull();
    claim.mockRestore();
    expect(await foldExpiredDigests(THRESHOLD)).toBe(2);
  });

  it('waits when an older ID has a newer retention timestamp', async () => {
    const podId = new mongoose.Types.ObjectId();
    const olderId = await seed(NOW, podId);
    await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);

    expect(await foldExpiredDigests(THRESHOLD)).toBe(0);
    expect(await AgentDigestState.findOne({ agentName: 'flint', podId })).toBeNull();
    await AgentEvent.collection.updateOne(
      { _id: olderId.insertedId },
      { $set: { createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) } },
    );
    expect(await foldExpiredDigests(THRESHOLD)).toBe(2);
  });

  it('settles the exact seen revision while preserving a newer fold', async () => {
    const podId = new mongoose.Types.ObjectId();
    const scope = { agentName: 'flint', instanceId: 'default', podId };
    await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    await foldExpiredDigests(THRESHOLD);
    const first = await readFoldedDigest(scope);
    expect(first).toMatchObject({ unreadCount: 1, revision: 1 });

    await seed(new Date(NOW.getTime() - 90 * 60 * 1000), podId);
    await foldExpiredDigests(THRESHOLD);
    await settleFoldedDigest(scope, first.revision);
    expect((await readFoldedDigest(scope)).unreadCount).toBe(2);

    const latest = await readFoldedDigest(scope);
    await settleFoldedDigest(scope, latest.revision);
    expect(await readFoldedDigest(scope)).toBeNull();
    expect((await AgentDigestState.findOne(scope).lean()).revision).toBe(3);
  });

  it('attaches the folded summary to a real wake and clears it on that wake ack', async () => {
    const podId = new mongoose.Types.ObjectId();
    const scope = { agentName: 'flint', instanceId: 'default', podId };
    await seed(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), podId);
    await foldExpiredDigests(THRESHOLD);
    const wake = await AgentEvent.create({ ...scope, type: 'heartbeat',
      status: 'delivered', deliveryMode: 'wake', attempts: 1, deliveryNonce: 'nonce-1' });

    expect(await AgentEventService.attachFoldedDigest(wake)).toMatchObject({ unreadCount: 1 });
    expect((await AgentEvent.findById(wake._id).lean()).digestRollupRevision).toBe(1);
    await AgentEventService.acknowledge(wake._id, 'flint', 'default', { outcome: 'no_action' }, 'nonce-1', 'cli');
    expect(await readFoldedDigest(scope)).toBeNull();
  });
});
