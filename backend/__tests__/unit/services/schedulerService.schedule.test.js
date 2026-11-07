jest.mock('../../../services/agentScheduleService', () => ({ dispatchSchedules: jest.fn().mockResolvedValue(2) }));

const SchedulerService = require('../../../services/schedulerService').constructor;
const { dispatchSchedules } = require('../../../services/agentScheduleService');

const NOW = new Date('2026-11-07T15:50:00Z');

describe('schedules run on the heartbeat tick', () => {
  beforeEach(() => {
    dispatchSchedules.mockClear();
    jest.spyOn(SchedulerService, 'dispatchAgentHeartbeats').mockResolvedValue({ scanned: 0, enqueued: 1, skippedByInterval: 0 });
    jest.spyOn(SchedulerService, 'dispatchUnreadDigestHeartbeats').mockResolvedValue(0);
  });
  afterEach(() => jest.restoreAllMocks());

  it('fires under the lease and counts its wakes', async () => {
    jest.spyOn(SchedulerService, 'tryAcquireHeartbeatDispatchLease').mockResolvedValue(true);
    const result = await SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW });
    expect(dispatchSchedules).toHaveBeenCalledWith(NOW);
    expect(result.enqueued).toBe(3);
  });

  it('does nothing on a tick that lost the lease', async () => {
    jest.spyOn(SchedulerService, 'tryAcquireHeartbeatDispatchLease').mockResolvedValue(false);
    await SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW });
    expect(dispatchSchedules).not.toHaveBeenCalled();
  });
});
