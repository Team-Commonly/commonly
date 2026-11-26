/**
 * F633: on prod the minute heartbeat dispatch takes 10–15s and enqueues about
 * nothing, while its heartbeat aggregate takes 32ms. These pin that one run
 * reports how long each step took, as numbers only, and that the cron line
 * keeps the exact prefix ops greps (`Agent heartbeats enqueued: <n>`).
 */
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn() },
}));
jest.mock('../../../models/Post', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/Message', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/pg/Message', () => ({
  findMostRecentPodActivity: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../models/SchedulerHeartbeatLease', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../services/agentScheduleService', () => ({
  dispatchSchedules: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../../models/AgentEvent', () => ({
  exists: jest.fn().mockResolvedValue(null),
  aggregate: jest.fn().mockResolvedValue([]),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const PGMessage = require('../../../models/pg/Message');
const SchedulerHeartbeatLease = require('../../../models/SchedulerHeartbeatLease');
const SchedulerService = require('../../../services/schedulerService').constructor;

const NOW = new Date('2026-11-25T10:04:00.000Z');

const rows = [
  // Opted in, reaches the per-install checks.
  { agentName: 'alpha', instanceId: 'default', podId: 'p1', config: { heartbeat: { enabled: true } } },
  // Global and opted in: the pod pick runs for it.
  { agentName: 'beta', instanceId: 'default', podId: 'p2', config: { heartbeat: { enabled: true, global: true } } },
  // Never opted in: stops before the per-install checks.
  { agentName: 'gamma', instanceId: 'default', podId: 'p3', config: {} },
];

const mockFind = () => {
  AgentInstallation.find.mockImplementation(() => {
    const lean = jest.fn().mockResolvedValue(rows);
    return { select: jest.fn().mockReturnValue({ lean }), lean };
  });
};

const STEP_KEYS = [
  'total', 'lease', 'schedules', 'heartbeats', 'installs', 'aggregate', 'globalPick', 'perInstall', 'unread',
  // F635: inside the unread step.
  'unreadEvents', 'unreadFold', 'unreadInstalls', 'unreadAllowed', 'unreadChecks', 'unreadEnqueue',
];

describe('dispatchScheduledAgentHeartbeats step timings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SchedulerHeartbeatLease.findOneAndUpdate.mockResolvedValue({});
    mockFind();
    jest.spyOn(SchedulerService, 'dispatchUnreadDigestHeartbeats').mockResolvedValue(0);
    jest.spyOn(SchedulerService, 'buildHeartbeatActivityHint').mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns timingsMs with every step as a non-negative number, and how many installs were checked', async () => {
    // Intervals off, so both opted-in installs are due: since F668 the pod
    // pick runs only for a global install that is due.
    const result = await SchedulerService.dispatchScheduledAgentHeartbeats({
      now: NOW, respectIntervals: false, trigger: 'scheduled-interval',
    });

    expect(result.skippedByLease).toBe(false);
    expect(Object.keys(result.timingsMs).sort()).toEqual([...STEP_KEYS].sort());
    for (const key of STEP_KEYS) {
      expect(typeof result.timingsMs[key]).toBe('number');
      expect(result.timingsMs[key]).toBeGreaterThanOrEqual(0);
    }
    expect(result.checked).toBe(2);
    // The global pick really ran, so its timing measures something.
    expect(PGMessage.findMostRecentPodActivity).toHaveBeenCalled();
  });

  it('passes a sink to the unread step and reports its sub-steps and due count (F635)', async () => {
    const filled = {
      unreadEvents: 20, unreadFold: 286, unreadInstalls: 184, unreadAllowed: 53, unreadChecks: 90, unreadEnqueue: 40,
    };
    SchedulerService.dispatchUnreadDigestHeartbeats.mockImplementation(async (now, sink) => {
      expect(now).toBe(NOW);
      Object.assign(sink, filled, { due: 82 });
      return 3;
    });

    const result = await SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW });

    expect(result.due).toBe(82);
    expect(result.enqueued).toBe(2 + 3);
    expect(result.timingsMs).toEqual(expect.objectContaining(filled));
  });

  it('keeps every existing field as it was', async () => {
    const result = await SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW });
    expect(result).toEqual(expect.objectContaining({
      scanned: 3, enqueued: 2, skippedByInterval: 0, skippedPending: 0, skippedByLease: false,
    }));
  });

  it('a run that loses the lease reports only the lease and the total', async () => {
    SchedulerHeartbeatLease.findOneAndUpdate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const result = await SchedulerService.dispatchScheduledAgentHeartbeats({ now: NOW });
    expect(result.skippedByLease).toBe(true);
    expect(Object.keys(result.timingsMs).sort()).toEqual(['lease', 'total']);
  });

  it('direct dispatch keeps its result shape', async () => {
    const result = await SchedulerService.dispatchAgentHeartbeats({ now: NOW });
    expect(Object.keys(result).sort()).toEqual(['enqueued', 'scanned', 'skippedByInterval', 'skippedPending']);
  });
});

describe('formatHeartbeatDispatchLine', () => {
  it('keeps the grepped prefix and appends the timings in a fixed order', () => {
    const line = SchedulerService.formatHeartbeatDispatchLine({
      scanned: 37,
      enqueued: 0,
      skippedByInterval: 30,
      skippedByLease: false,
      checked: 37,
      timingsMs: {
        total: 12345.4, lease: 3.2, schedules: 10, heartbeats: 11972, installs: 40,
        aggregate: 32, globalPick: 900, perInstall: 11000, unread: 200,
      },
    });
    expect(line).toBe(
      'Agent heartbeats enqueued: 0 (ms total=12345 lease=3 schedules=10 heartbeats=11972'
      + ' installs=40 aggregate=32 globalPick=900 perInstall=11000 unread=200; checked=37)',
    );
  });

  it('prints the unread sub-steps after unread, and due next to checked (F635)', () => {
    const line = SchedulerService.formatHeartbeatDispatchLine({
      scanned: 37,
      enqueued: 4,
      skippedByInterval: 30,
      skippedByLease: false,
      checked: 37,
      due: 82,
      timingsMs: {
        total: 4300.6, lease: 3, schedules: 10, heartbeats: 120, installs: 40,
        aggregate: 32, globalPick: 9, perInstall: 30, unread: 4100.2,
        unreadEvents: 20.4, unreadFold: 286.5, unreadInstalls: 184, unreadAllowed: 53,
        unreadChecks: 3500, unreadEnqueue: 2100.49,
      },
    });
    expect(line).toBe(
      'Agent heartbeats enqueued: 4 (ms total=4301 lease=3 schedules=10 heartbeats=120'
      + ' installs=40 aggregate=32 globalPick=9 perInstall=30 unread=4100'
      + ' unreadEvents=20 unreadFold=287 unreadInstalls=184 unreadAllowed=53 unreadChecks=3500 unreadEnqueue=2100'
      + '; checked=37 due=82)',
    );
  });

  it('keeps the lease suffix and prints only the steps that ran', () => {
    const line = SchedulerService.formatHeartbeatDispatchLine({
      scanned: 0, enqueued: 0, skippedByInterval: 0, skippedByLease: true,
      timingsMs: { total: 4, lease: 4 },
    });
    expect(line).toBe('Agent heartbeats enqueued: 0 (another scheduler holds the lease) (ms total=4 lease=4)');
  });

  it('prints the old line when there are no timings', () => {
    expect(SchedulerService.formatHeartbeatDispatchLine({
      scanned: 0, enqueued: 3, skippedByInterval: 0, skippedByLease: false,
    })).toBe('Agent heartbeats enqueued: 3');
  });
});
