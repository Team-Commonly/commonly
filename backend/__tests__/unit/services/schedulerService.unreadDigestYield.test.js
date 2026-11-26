/**
 * F668: the unread-digest pass runs inside the minute heartbeat tick. On prod
 * 2026-11-26 12:06 one tick took 4,913 ms and the event loop stalled 2,035 ms;
 * about 1.5 s of that tick was this pass. With thousands of candidate groups
 * it must hand the event loop back between chunks, not walk them in one block.
 *
 * Every read here resolves at once (mocked), so the only way a callback queued
 * with setImmediate before the pass can run before the pass ends is if the
 * pass itself yields a macrotask turn.
 */
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../../models/AgentEvent', () => ({
  exists: jest.fn().mockResolvedValue(null),
  aggregate: jest.fn().mockResolvedValue([]),
  find: jest.fn(),
}));
jest.mock('../../../repositories/agentDigestStateRepository', () => ({
  listDueForWake: jest.fn().mockResolvedValue([]),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEvent = require('../../../models/AgentEvent');
const AgentEventService = require('../../../services/agentEventService');
const SchedulerService = require('../../../services/schedulerService').constructor;

const NOW = new Date('2026-11-26T12:06:00.000Z');
const GROUPS = 1000;

const groups = Array.from({ length: GROUPS }, (_, i) => ({
  _id: { agentName: `seat${i}`, instanceId: 'default', podId: `pod${i}` },
  oldestAt: new Date(NOW.getTime() - 90 * 60000),
}));

// A thenable query chain that resolves at once to `rows`.
const chain = (rows) => {
  const q = {
    select: () => q,
    sort: () => q,
    lean: () => q,
    exec: () => Promise.resolve(rows),
    then: (ok, fail) => Promise.resolve(rows).then(ok, fail),
  };
  return q;
};

describe('F668 — the unread-digest pass yields between chunks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.aggregate.mockImplementation(async (pipeline) => (
      pipeline[0].$match.deliveryMode === 'digest' ? groups : []));
    AgentEvent.find.mockImplementation(() => chain([]));
    // Retired projections: no group has an active install.
    AgentInstallation.find.mockImplementation(() => chain([]));
  });

  it('a setImmediate callback queued before the pass runs before the pass finishes', async () => {
    let ranAt = null;
    let finishedAt = null;
    let tick = 0;
    setImmediate(() => { tick += 1; ranAt = tick; });

    const enqueued = await SchedulerService.dispatchUnreadDigestHeartbeats(NOW);
    tick += 1;
    finishedAt = tick;

    expect(enqueued).toBe(0);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(ranAt).not.toBeNull();
    expect(ranAt).toBeLessThan(finishedAt);
  });
});
