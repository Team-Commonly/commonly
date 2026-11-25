// F628: every backend start ran the summarizer sweep 5 seconds in, so each
// restart sent every pod another hourly summary.request. The startup run now
// tops up per install: an install that already got an hourly request inside
// the window is left out, the rest get one. A restart mid-sweep therefore
// still reaches the pods the first sweep never got to. The hourly cron and
// the manual trigger pass no set and always send to every install.
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, fn) => ({ expression, fn, start: jest.fn(), stop: jest.fn() })),
}));
jest.mock('../../../models/AgentEvent', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));
jest.mock('../../../utils/safeErrorLog', () => ({
  ...jest.requireActual('../../../utils/safeErrorLog'),
  logOutboundFailure: jest.fn(),
}));

const cron = require('node-cron');
const AgentEvent = require('../../../models/AgentEvent');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEventService = require('../../../services/agentEventService');
const { logOutboundFailure } = require('../../../utils/safeErrorLog');
const summarizerService = require('../../../services/summarizerService');
const scheduler = require('../../../services/schedulerService');

const SchedulerService = scheduler.constructor;
const MIN = 60 * 1000;

const SHARED_POD = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const INSTALLS = [
  { podId: 'p1', instanceId: 'default' },
  { podId: 'p2' }, // no instanceId: counts as 'default'
  { podId: 'p3', instanceId: 'alt' },
  // Two instances in one pod: the key must tell them apart.
  { podId: SHARED_POD, instanceId: 'one' },
  { podId: SHARED_POD, instanceId: 'two' },
];
const ALL_COVERED = [
  { podId: 'p1', instanceId: 'default' },
  { podId: 'p2', instanceId: 'default' },
  { podId: 'p3', instanceId: 'alt' },
  { podId: SHARED_POD, instanceId: 'one' },
  { podId: SHARED_POD, instanceId: 'two' },
];

const setInstalls = (rows) => {
  AgentInstallation.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
  });
};

let findQuery;
let findChain;
const setRecentRows = (rows) => {
  findChain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  AgentEvent.find.mockImplementation((query) => {
    findQuery = query;
    return findChain;
  });
};

const requestedPods = () => AgentEventService.enqueue.mock.calls.map((c) => c[0].podId).sort();

describe('scheduler: startup summarizer tops up per install', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    process.env.SUMMARIZER_FANOUT_BATCH_PAUSE_MS = '0';
    setInstalls(INSTALLS);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // The summarizer's own steps are not under test; the dispatch step is.
    jest.spyOn(summarizerService.constructor, 'garbageCollectForDigest').mockResolvedValue({});
    jest.spyOn(SchedulerService, 'summarizeIntegrationBuffers').mockResolvedValue([]);
  });
  afterEach(() => {
    scheduler.stop();
    cron.schedule.mockClear();
    delete process.env.SUMMARIZER_FANOUT_BATCH_PAUSE_MS;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const bootAndWait = async () => {
    scheduler.start();
    await jest.advanceTimersByTimeAsync(5001);
  };

  it('sends nothing and logs when every install was requested recently', async () => {
    setRecentRows(ALL_COVERED);
    await bootAndWait();
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(console.log.mock.calls.map((c) => c.join(' ')).some((l) => /skipping startup summarizer/i.test(l))).toBe(true);
  });

  it('sends only to installs not requested recently, and logs how many it skipped', async () => {
    setRecentRows([{ podId: 'p1', instanceId: 'default' }]);
    await bootAndWait();
    expect(requestedPods()).toEqual(['p2', 'p3', SHARED_POD, SHARED_POD].sort());
    const line = console.log.mock.calls.map((c) => c.join(' ')).find((l) => /skipped.*recently requested/i.test(l));
    expect(line).toMatch(/1/);
  });

  it('counts a row with no instanceId as default', async () => {
    setRecentRows([{ podId: 'p2' }]);
    await bootAndWait();
    expect(requestedPods()).toEqual(['p1', 'p3', SHARED_POD, SHARED_POD].sort());
  });

  it('tells two instances in one pod apart: covering one still requests the other', async () => {
    setRecentRows([{ podId: SHARED_POD, instanceId: 'one' }]);
    await bootAndWait();
    const forPod = AgentEventService.enqueue.mock.calls.map((c) => c[0]).filter((e) => e.podId === SHARED_POD);
    expect(forPod).toHaveLength(1);
    expect(forPod[0]).toMatchObject({ podId: SHARED_POD, instanceId: 'two' });
  });

  it('sends to every install when none was requested recently', async () => {
    setRecentRows([]);
    await bootAndWait();
    expect(requestedPods()).toEqual(['p1', 'p2', 'p3', SHARED_POD, SHARED_POD].sort());
  });

  it('sends to every install and logs when the read throws', async () => {
    AgentEvent.find.mockImplementation(() => { throw new Error('db down'); });
    await bootAndWait();
    expect(requestedPods()).toEqual(['p1', 'p2', 'p3', SHARED_POD, SHARED_POD].sort());
    expect(logOutboundFailure).toHaveBeenCalled();
  });

  it('the hourly cron sends to every install right after a sweep', async () => {
    setRecentRows(ALL_COVERED);
    scheduler.start();
    const hourly = cron.schedule.mock.results.map((r) => r.value).find((j) => j.expression === '0 * * * *');
    await hourly.fn();
    expect(requestedPods()).toEqual(['p1', 'p2', 'p3', SHARED_POD, SHARED_POD].sort());
    expect(AgentEvent.find).not.toHaveBeenCalled();
  });

  it('reads hourly summary.request rows for commonly-bot inside the window, podId and instanceId only', async () => {
    setRecentRows([]);
    const before = Date.now();
    await bootAndWait();
    expect(findQuery).toMatchObject({
      agentName: 'commonly-bot',
      type: 'summary.request',
      'payload.trigger': 'scheduled-hourly',
    });
    const bound = findQuery.createdAt.$gte;
    expect(bound).toBeInstanceOf(Date);
    // 45 minutes before the check; the check runs 5s into the faked clock.
    const expected = before + 5000 - 45 * MIN;
    expect(Math.abs(bound.getTime() - expected)).toBeLessThan(2000);
    expect(findChain.select).toHaveBeenCalledWith('podId instanceId');
  });
});
