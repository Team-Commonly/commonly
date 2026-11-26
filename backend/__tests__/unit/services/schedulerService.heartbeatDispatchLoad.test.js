// F668: on 2026-11-26 one minute's heartbeat dispatch held the prod event loop
// (`heartbeats=2356` ms, 2035 ms of loop lag) and enqueued nothing. These pin
// that dispatch asks Mongo only for opted-in installs, skips the heavy steps
// (pod pick, pending check, activity hint) for installs that are not due, and
// yields to the event loop between chunks when there is a lot to process.
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
jest.mock('../../../models/AgentEvent', () => ({
  exists: jest.fn().mockResolvedValue(null),
  aggregate: jest.fn().mockResolvedValue([]),
}));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEvent = require('../../../models/AgentEvent');
const PGMessage = require('../../../models/pg/Message');
const Post = require('../../../models/Post');
const SchedulerService = require('../../../services/schedulerService').constructor;

const NOW = new Date('2026-11-26T12:06:00.000Z');
const N = 2000;

// Every tenth install is global, so the pod pick has work to skip.
const installs = Array.from({ length: N }, (_, i) => ({
  agentName: `agent${i}`,
  instanceId: 'default',
  podId: `pod${i}`,
  config: { heartbeat: { enabled: true, everyMinutes: 60, ...(i % 10 === 0 ? { global: true } : {}) } },
}));

let findFilter;
const mockFind = (rows) => {
  AgentInstallation.find.mockImplementation((filter) => {
    findFilter = filter;
    const lean = jest.fn().mockResolvedValue(rows);
    return { select: jest.fn().mockReturnValue({ lean }), lean };
  });
};

describe('heartbeat dispatch load (F668)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findFilter = undefined;
    jest.spyOn(SchedulerService, 'buildHeartbeatActivityHint').mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks Mongo only for opted-in installs, and the heartbeat aggregate only for their agents', async () => {
    mockFind(installs.slice(0, 3));
    await SchedulerService.dispatchAgentHeartbeats({ now: NOW, respectIntervals: true });
    expect(findFilter).toEqual(expect.objectContaining({
      status: 'active',
      'config.heartbeat.enabled': true,
    }));
    // Not autonomy: a global agent's dedupe picks its first opted-in install
    // before the autonomy check, so filtering it would change the winner.
    expect(findFilter).not.toHaveProperty(['config.autonomy.enabled']);
    const [pipeline] = AgentEvent.aggregate.mock.calls[0];
    expect(pipeline[0].$match.type).toBe('heartbeat');
    expect(pipeline[0].$match.agentName.$in).toEqual(expect.arrayContaining(['agent0', 'agent1', 'agent2']));
  });

  it('with no opted-in installs it stops after the install read', async () => {
    mockFind([]);
    const r = await SchedulerService.dispatchAgentHeartbeats({ now: NOW, respectIntervals: true });
    expect(r.enqueued).toBe(0);
    expect(AgentEvent.aggregate).not.toHaveBeenCalled();
  });

  it(`with ${N} opted-in installs and none due it enqueues 0 and runs no heavy step`, async () => {
    mockFind(installs);
    // Each one heartbeated a minute ago, so none is due for 59 more minutes.
    AgentEvent.aggregate.mockResolvedValue(installs.map((i) => ({
      _id: { agentName: i.agentName, instanceId: 'default', podId: i.podId },
      lastCreatedAt: new Date(NOW.getTime() - 60 * 1000),
    })));

    const r = await SchedulerService.dispatchAgentHeartbeats({ now: NOW, respectIntervals: true });

    expect(r.enqueued).toBe(0);
    expect(r.skippedByInterval).toBe(N);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(AgentEvent.exists).not.toHaveBeenCalled();
    expect(SchedulerService.buildHeartbeatActivityHint).not.toHaveBeenCalled();
    // The global pod pick reads Postgres and Mongo; nothing due, nothing to pick.
    expect(PGMessage.findMostRecentPodActivity).not.toHaveBeenCalled();
    expect(Post.aggregate).not.toHaveBeenCalled();
  });

  it('yields to the event loop between chunks when many installs are due', async () => {
    mockFind(installs);
    let dispatchDone = false;
    let ranBeforeDone = null;
    setImmediate(() => { ranBeforeDone = !dispatchDone; });

    const r = await SchedulerService.dispatchAgentHeartbeats({ now: NOW, respectIntervals: false });
    dispatchDone = true;

    expect(r.enqueued).toBe(N);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(N);
    expect(ranBeforeDone).toBe(true);
  });
});
