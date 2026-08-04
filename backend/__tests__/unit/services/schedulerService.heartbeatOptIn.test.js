/**
 * Heartbeat dispatch is opt-in (#832 follow-up).
 *
 * The guard used to be `enabled === false`, which meant an install that had
 * never expressed an opinion still woke on a timer. Measured on production
 * 2026-08-04: 166 of 245 active installations, across 48 distinct owners, were
 * ticking hourly on that default alone — each spending its own owner's model
 * quota to run a heartbeat that has no content contract behind it (#800).
 *
 * The distinction this file defends is `undefined` vs `true`. A test that only
 * covered `false` would have passed against the old behaviour too.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn() },
}));
// The enqueue path builds an activity hint from recent posts; that aggregate
// is not what this file is testing, and unmocked it blocks on a real Mongo.
jest.mock('../../../models/Post', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/Message', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const SchedulerService = require('../../../services/schedulerService').constructor;

const install = (heartbeat) => ({
  _id: 'i1',
  agentName: 'a',
  instanceId: 'default',
  podId: 'p1',
  status: 'active',
  config: heartbeat === undefined ? {} : { heartbeat },
});

const mockFind = (rows) => {
  const lean = jest.fn().mockResolvedValue(rows);
  const select = jest.fn().mockReturnValue({ lean });
  AgentInstallation.find.mockReturnValue({ select, lean });
};

describe('dispatchAgentHeartbeats — opt-in', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an install with no heartbeat config does NOT fire', async () => {
    mockFind([install(undefined)]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBe(0);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('an install with heartbeat present but enabled unset does NOT fire', async () => {
    mockFind([install({ everyMinutes: 60 })]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBe(0);
  });

  test('enabled:false still does not fire', async () => {
    mockFind([install({ enabled: false, everyMinutes: 60 })]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBe(0);
  });

  test('enabled:true DOES fire — opting in still works', async () => {
    mockFind([install({ enabled: true, everyMinutes: 60 })]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBeGreaterThan(0);
  });
});
