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

  describe('hosted digest wake follows the heartbeat setting (F194)', () => {
    // Earned 2026-11-05: a hosted agent whose Heartbeat select read Off
    // (config.heartbeat null) still took an hourly unaddressed turn its owner
    // paid for. A hosted install's digest now rides its next wake unless the
    // owner turned the heartbeat on; every other runtime keeps the hourly wake.
    const old = () => new Date(NOW.getTime() - 61 * 60000);
    const seed = async (config, { digestEvent = true } = {}) => {
      const scope = { agentName: 'kai', instanceId: 'default', podId: new mongoose.Types.ObjectId() };
      await AgentInstallation.collection.insertOne({ ...scope, status: 'active',
        version: '1.0.0', installedBy: new mongoose.Types.ObjectId(), ...(config ? { config } : {}) });
      if (digestEvent) {
        await AgentEvent.collection.insertOne({ ...scope, type: 'message.posted', status: 'pending',
          deliveryMode: 'digest', attempts: 0, createdAt: old() });
      }
      return scope;
    };
    const hosted = { runtime: { runtimeType: 'hosted' } };

    it('gives a hosted install with heartbeat null no digest wake', async () => {
      const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      await seed({ ...hosted, heartbeat: null });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('gives a hosted install with heartbeat disabled no digest wake', async () => {
      const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      await seed({ ...hosted, heartbeat: { enabled: false, everyMinutes: 60 } });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('gives folded digest on a hosted install with heartbeat off no wake', async () => {
      const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      const scope = await seed(hosted, { digestEvent: false });
      await AgentDigestState.collection.insertOne({ ...scope, unreadCount: 2, revision: 2,
        lastEventIds: ['a', 'b'], unreadSince: old(), updatedAt: NOW });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('treats a runtime-less projection of a hosted identity as hosted', async () => {
      const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      await AgentInstallation.collection.insertOne({ agentName: 'kai', instanceId: 'default',
        podId: new mongoose.Types.ObjectId(), status: 'active', version: '1.0.0',
        installedBy: new mongoose.Types.ObjectId(), config: hosted, createdAt: old() });
      await seed({ heartbeat: null });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still wakes a hosted install whose heartbeat is on', async () => {
      const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      const scope = await seed({ ...hosted, heartbeat: { enabled: true, everyMinutes: 60 } });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        ...scope, type: 'heartbeat', payload: expect.objectContaining({ trigger: 'unread-digest' }),
      }));
    });

    it.each([
      ['native', { runtime: { runtimeType: 'native' }, heartbeat: null }],
      ['webhook', { runtime: { runtimeType: 'webhook' } }],
      ['claude-code (BYO)', { runtime: { runtimeType: 'claude-code' }, heartbeat: { enabled: false } }],
      ['moltbot', { runtime: { runtimeType: 'moltbot' } }],
    ])('still wakes a %s install with heartbeat off', async (_label, config) => {
      jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      await seed(config);
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    });
  });

  describe('per-install digest wake wait (config.digestWake.afterMinutes)', () => {
    // Earned 2026-10-25: these wakes were 330 of 1,821 seat turns in 24h,
    // 311 of them empty; 15 seats got 0 posts from them. Those seats get a
    // longer wait, and every other install keeps the 60-minute default.
    const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
    const seed = async (config, unreadMinutesAgo) => {
      const scope = { agentName: 'kai', instanceId: 'default', podId: new mongoose.Types.ObjectId() };
      await AgentInstallation.collection.insertOne({ ...scope, status: 'active',
        version: '1.0.0', installedBy: new mongoose.Types.ObjectId(), ...(config ? { config } : {}) });
      await AgentEvent.collection.insertOne({ ...scope, type: 'message.posted', status: 'pending',
        deliveryMode: 'digest', attempts: 0, createdAt: minutesAgo(unreadMinutesAgo) });
      return scope;
    };

    it('keeps 60 minutes when the install sets nothing', async () => {
      jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      await seed(null, 61);
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    });

    it('waits for the override before waking', async () => {
      const enqueue = jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      const scope = await seed({ digestWake: { afterMinutes: 240 } }, 61);
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
      await AgentEvent.collection.insertOne({ ...scope, type: 'message.posted', status: 'pending',
        deliveryMode: 'digest', attempts: 0, createdAt: minutesAgo(241) });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ ...scope, type: 'heartbeat' }));
    });

    it('counts a turn anywhere inside the longer wait as recent', async () => {
      jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      const scope = await seed({ digestWake: { afterMinutes: 240 } }, 300);
      await AgentEvent.collection.insertOne({ ...scope, type: 'chat.mention', status: 'acked',
        deliveryMode: 'wake', attempts: 1, deliveredAt: minutesAgo(120), createdAt: minutesAgo(121) });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    });

    it('applies the override to digest folded past retention', async () => {
      jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
      const scope = { agentName: 'kai', instanceId: 'default', podId: new mongoose.Types.ObjectId() };
      await AgentInstallation.collection.insertOne({ ...scope, status: 'active', version: '1.0.0',
        installedBy: new mongoose.Types.ObjectId(), config: { digestWake: { afterMinutes: 240 } } });
      await AgentDigestState.collection.insertOne({ ...scope, unreadCount: 2, revision: 2,
        lastEventIds: ['a', 'b'], unreadSince: minutesAgo(90), updatedAt: NOW });
      expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    });

    it('clamps an override to 60..1440 and ignores a non-number', () => {
      const wait = (afterMinutes) => SchedulerService.resolveDigestWakeAfterMinutes({ config: { digestWake: { afterMinutes } } });
      expect(wait(5)).toBe(60);
      expect(wait(100000)).toBe(1440);
      expect(wait('soon')).toBe(60);
      expect(wait(240)).toBe(240);
      expect(SchedulerService.resolveDigestWakeAfterMinutes(null)).toBe(60);
    });
  });
});
