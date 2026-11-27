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
const { listDueForWake } = require('../../../repositories/agentDigestStateRepository');
const SchedulerService = require('../../../services/schedulerService').constructor;

const NOW = new Date('2026-11-26T12:06:00.000Z');
const GROUPS = 1000;
// A distinct pod id with the real shape (24 hex), so no case leans on an id
// that a cast would refuse.
const podIdAt = (i) => i.toString(16).padStart(24, '0');

const groups = Array.from({ length: GROUPS }, (_, i) => ({
  _id: { agentName: `seat${i}`, instanceId: 'default', podId: podIdAt(i) },
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
    // findDigestWakeBlockers casts each $match through a query; the mock passes it on.
    cast: (_model, filter) => filter,
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

  // Each loop's own yields, apart from the reads': every read and every yield
  // is logged in order. A loop's yields land where nothing else yields (after
  // the last read before it, or at the very end), so removing that loop's
  // yield removes exactly those entries. 401 items: yields at 200 and 400.
  describe('each traversal yields on its own', () => {
    let log;
    let immediateSpy;
    const scopeAt = (i) => ({ agentName: `seat${i}`, instanceId: 'default', podId: podIdAt(i) });
    const groupRow = (scope) => ({ _id: scope, oldestAt: new Date(NOW.getTime() - 90 * 60000) });
    const scopesOf = (filter) => (filter.$or || []).map(({ agentName, instanceId, podId }) => ({ agentName, instanceId, podId }));

    beforeEach(() => {
      log = [];
      const realSetImmediate = global.setImmediate;
      // Logged when the turn boundary happens, not when it is asked for: a
      // read started just before a yield runs in that turn's microtasks.
      immediateSpy = jest.spyOn(global, 'setImmediate').mockImplementation((fn, ...args) => (
        realSetImmediate(() => { log.push('yield'); fn(...args); })));
    });
    afterEach(() => immediateSpy.mockRestore());

    const run = async ({ groupRows, activeInstalls = false, allPending = false }) => {
      AgentEvent.aggregate.mockImplementation(async (pipeline) => {
        const match = pipeline[0].$match;
        if (match.deliveryMode === 'digest') { log.push('events:candidates'); return groupRows; }
        if (match.status === 'pending') {
          log.push('events:pending');
          return allPending ? scopesOf(match).map((scope) => ({ _id: scope })) : [];
        }
        log.push('events:recent');
        return [];
      });
      listDueForWake.mockImplementation(async () => { log.push('fold'); return []; });
      AgentInstallation.find.mockImplementation((filter) => {
        log.push('installs');
        return chain(activeInstalls
          ? scopesOf(filter).map((scope) => ({ ...scope, config: { heartbeat: { enabled: true } } }))
          : []);
      });
      return SchedulerService.dispatchUnreadDigestHeartbeats(NOW);
    };

    it('the group walk: 401 rows for one scope yield before the one install read', async () => {
      const one = scopeAt(0);
      await run({ groupRows: Array.from({ length: 401 }, () => groupRow(one)) });
      expect(log).toEqual(['events:candidates', 'fold', 'yield', 'yield', 'installs']);
    });

    it('the candidate checks: 401 groups yield after their last install read', async () => {
      await run({ groupRows: Array.from({ length: 401 }, (_, i) => groupRow(scopeAt(i))) });
      expect(log).toEqual([
        'events:candidates', 'fold', 'yield', 'yield', // group walk
        'installs', 'yield', 'installs', 'yield', 'installs', // three install reads
        'yield', 'yield', // candidate checks
      ]);
    });

    it('the held due entries: 401 groups a pending wake holds yield after the last check read', async () => {
      const enqueued = await run({
        groupRows: Array.from({ length: 401 }, (_, i) => groupRow(scopeAt(i))),
        activeInstalls: true,
        allPending: true,
      });
      expect(enqueued).toBe(0);
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(log).toEqual([
        'events:candidates', 'fold', 'yield', 'yield', // group walk
        'installs', 'yield', 'installs', 'yield', 'installs', // three install reads
        'yield', 'yield', // candidate checks
        'events:pending', 'yield', 'events:pending', 'yield', 'events:pending', // three pending reads
        'yield', 'yield', // held due entries
      ]);
    });
  });
});
