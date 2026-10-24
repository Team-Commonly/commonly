// The lease is a correctness boundary between backend replicas, so these use
// MongoMemoryServer instead of a mocked model. In particular, the duplicate
// key race is Mongo's compare-and-set behavior, not a predicate copied into a
// Jest mock.
jest.mock('jsonwebtoken', () => ({}));

const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const SchedulerHeartbeatLease = require('../../../models/SchedulerHeartbeatLease');
const AgentEvent = require('../../../models/AgentEvent');
const AgentDigestState = require('../../../models/AgentDigestState');
const AgentEventService = require('../../../services/agentEventService');
const mongoose = require('mongoose');
const schedulerServiceInstance = require('../../../services/schedulerService');

const SchedulerService = schedulerServiceInstance.constructor;

const LEASE_ID = 'agent-heartbeat-dispatch';
const NOW = new Date('2026-08-21T08:00:00.000Z');

describe('SchedulerService automatic heartbeat dispatch lease', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
  });

  it('admits exactly one of two simultaneous scheduler replicas', async () => {
    const acquired = await Promise.all([
      SchedulerService.tryAcquireHeartbeatDispatchLease(NOW),
      SchedulerService.tryAcquireHeartbeatDispatchLease(NOW),
    ]);

    expect(acquired.filter(Boolean)).toHaveLength(1);
    const lease = await SchedulerHeartbeatLease.findById(LEASE_ID).lean();
    expect(lease).toEqual(expect.objectContaining({
      _id: LEASE_ID,
      expiresAt: expect.any(Date),
    }));
  });

  it('does not admit another scheduler until the stored lease expires', async () => {
    await expect(SchedulerService.tryAcquireHeartbeatDispatchLease(NOW)).resolves.toBe(true);
    const lease = await SchedulerHeartbeatLease.findById(LEASE_ID).lean();
    const expiresAt = new Date(lease.expiresAt);

    await expect(
      SchedulerService.tryAcquireHeartbeatDispatchLease(new Date(expiresAt.getTime() - 1)),
    ).resolves.toBe(false);
    await expect(SchedulerService.tryAcquireHeartbeatDispatchLease(expiresAt)).resolves.toBe(true);
  });

  it('runs the scheduled wrapper once', async () => {
    const directDispatch = jest.spyOn(SchedulerService, 'dispatchAgentHeartbeats').mockResolvedValue({
      scanned: 3,
      enqueued: 2,
      skippedByInterval: 1,
    });

    const results = await Promise.all([
      SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW }),
      SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW }),
    ]);

    expect(directDispatch).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.skippedByLease)).toEqual([
      { scanned: 0, enqueued: 0, skippedByInterval: 0, skippedByLease: true },
    ]);
    expect(results.find((result) => !result.skippedByLease)).toEqual({
      scanned: 3,
      enqueued: 2,
      skippedByInterval: 1,
      skippedByLease: false,
    });
  });

  it('keeps direct dispatch available while an automatic lease is held', async () => {
    await expect(SchedulerService.tryAcquireHeartbeatDispatchLease(NOW)).resolves.toBe(true);
    const lean = jest.fn().mockResolvedValue([]);
    const select = jest.fn().mockReturnValue({ lean });
    jest.spyOn(AgentInstallation, 'find').mockReturnValue({
      select,
    });

    await expect(SchedulerService.dispatchAgentHeartbeats()).resolves.toEqual({
      scanned: 0,
      enqueued: 0,
      skippedByInterval: 0,
    });
    expect(AgentInstallation.find).toHaveBeenCalledWith({ status: 'active' });
  });

  it('only wakes a pod with digest unread for 60 minutes and no recent or pending wake', async () => {
    const podId = new mongoose.Types.ObjectId();
    const scope = { agentName: 'flint', instanceId: 'default', podId };
    const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    await AgentEvent.collection.insertOne({ ...scope, type: 'message.posted', status: 'pending',
      deliveryMode: 'digest', attempts: 0, createdAt: new Date(NOW.getTime() - 61 * 60000) });
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    await AgentInstallation.collection.insertOne({ ...scope, status: 'active',
      version: '1.0.0', installedBy: new mongoose.Types.ObjectId() });
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      ...scope, type: 'heartbeat', payload: expect.objectContaining({ trigger: 'unread-digest' }),
    }));

    enqueue.mockClear();
    await AgentEvent.collection.insertOne({ ...scope, type: 'chat.mention', status: 'pending',
      deliveryMode: 'wake', attempts: 0, createdAt: NOW });
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    await AgentEvent.deleteMany({ ...scope, type: 'chat.mention' });
    await AgentEvent.collection.insertOne({ ...scope, type: 'chat.mention', status: 'acked',
      deliveryMode: 'wake', attempts: 1, deliveredAt: new Date(NOW.getTime() - 30 * 60000), createdAt: NOW });
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('waits an hour after a wake fails, even if it was delivered earlier', async () => {
    const scope = { agentName: 'flint', instanceId: 'default', podId: new mongoose.Types.ObjectId() };
    const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
    const old = new Date(NOW.getTime() - 61 * 60000);
    await AgentInstallation.collection.insertOne({ ...scope, status: 'active',
      version: '1.0.0', installedBy: new mongoose.Types.ObjectId() });
    await AgentEvent.collection.insertOne({ ...scope, type: 'message.posted', status: 'pending',
      deliveryMode: 'digest', attempts: 0, createdAt: old });
    const failed = await AgentEvent.collection.insertOne({ ...scope, type: 'heartbeat', status: 'failed',
      deliveryMode: 'wake', attempts: 1, createdAt: old, deliveredAt: old, updatedAt: NOW });
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    await AgentEvent.collection.updateOne({ _id: failed.insertedId }, { $set: { updatedAt: old } });
    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
  });

  it('also wakes for unread digest folded past full-event retention', async () => {
    const podId = new mongoose.Types.ObjectId();
    const scope = { agentName: 'flint', instanceId: 'default', podId };
    const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
    await AgentInstallation.collection.insertOne({ ...scope, status: 'active',
      version: '1.0.0', installedBy: new mongoose.Types.ObjectId() });
    await AgentDigestState.collection.insertOne({ ...scope, unreadCount: 2, revision: 2,
      lastEventIds: ['old-1', 'old-2'],
      unreadSince: new Date(NOW.getTime() - 61 * 60000), updatedAt: NOW });

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not wake an installation whose autonomy is disabled', async () => {
    const podId = new mongoose.Types.ObjectId();
    const scope = { agentName: 'flint', instanceId: 'default', podId };
    const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
    await AgentInstallation.collection.insertOne({ ...scope, status: 'active',
      version: '1.0.0', installedBy: new mongoose.Types.ObjectId(),
      config: { autonomy: { enabled: false } } });
    await AgentEvent.collection.insertOne({ ...scope, type: 'message.posted', status: 'pending',
      deliveryMode: 'digest', attempts: 0, createdAt: new Date(NOW.getTime() - 61 * 60000) });

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
