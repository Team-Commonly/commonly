/**
 * A seat that never picks up its heartbeats must not pile them up.
 *
 * Earned 2026-10-14: a cloud seat with no listener had 168 undelivered
 * heartbeats queued over nine days, and each one read as activity. One pending
 * heartbeat already says everything the next one would, so dispatch skips a
 * seat and pod that still has one waiting.
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
const mockExists = jest.fn();
jest.mock('../../../models/AgentEvent', () => ({
  exists: (...args) => mockExists(...args),
  aggregate: jest.fn().mockResolvedValue([]),
}));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const SchedulerService = require('../../../services/schedulerService').constructor;

const install = (agentName, podId) => ({
  _id: `${agentName}-${podId}`,
  agentName,
  instanceId: 'default',
  podId,
  status: 'active',
  config: { heartbeat: { enabled: true, everyMinutes: 60 } },
});

const mockFind = (rows) => {
  const lean = jest.fn().mockResolvedValue(rows);
  const select = jest.fn().mockReturnValue({ lean });
  AgentInstallation.find.mockReturnValue({ select, lean });
};

const dispatch = () => SchedulerService.dispatchAgentHeartbeats({ trigger: 'test', respectIntervals: false });

describe('dispatchAgentHeartbeats — no pile-up behind an undelivered heartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExists.mockResolvedValue(null);
  });

  test('a seat whose last heartbeat is still pending gets no new one', async () => {
    mockFind([install('RedBot', 'p1')]);
    mockExists.mockResolvedValue({ _id: 'evt-old' });

    const r = await dispatch();

    expect(r.enqueued).toBe(0);
    expect(r.skippedPending).toBe(1);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(mockExists).toHaveBeenCalledWith({
      agentName: 'redbot', instanceId: 'default', podId: 'p1', type: 'heartbeat', status: 'pending',
    });
  });

  test('a seat that picked up its last heartbeat gets the next one', async () => {
    mockFind([install('a', 'p1')]);
    const r = await dispatch();
    expect(r.enqueued).toBe(1);
    expect(r.skippedPending).toBe(0);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });

  test('only the stuck seat is skipped', async () => {
    mockFind([install('stuck', 'p1'), install('live', 'p2')]);
    mockExists.mockImplementation(async (q) => (q.agentName === 'stuck' ? { _id: 'evt-old' } : null));
    const r = await dispatch();
    expect(r.enqueued).toBe(1);
    expect(r.skippedPending).toBe(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'live' }));
  });
});
