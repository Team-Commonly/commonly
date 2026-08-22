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
});
