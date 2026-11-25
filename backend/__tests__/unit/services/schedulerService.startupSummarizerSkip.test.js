// F628: every backend start ran the summarizer sweep 5 seconds in, so each
// restart sent every pod another hourly summary.request. The startup run now
// skips when the newest hourly request is younger than the skip window. The
// hourly cron and the manual trigger never skip.
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, fn) => ({ expression, fn, start: jest.fn(), stop: jest.fn() })),
}));
jest.mock('../../../models/AgentEvent', () => ({ findOne: jest.fn() }));
jest.mock('../../../utils/safeErrorLog', () => ({
  ...jest.requireActual('../../../utils/safeErrorLog'),
  logOutboundFailure: jest.fn(),
}));

const cron = require('node-cron');
const AgentEvent = require('../../../models/AgentEvent');
const { logOutboundFailure } = require('../../../utils/safeErrorLog');
const scheduler = require('../../../services/schedulerService');

const SchedulerService = scheduler.constructor;
const MIN = 60 * 1000;

const newestRow = (ageMs) => {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(ageMs === null ? null : { createdAt: new Date(Date.now() - ageMs) }),
  };
  AgentEvent.findOne.mockReturnValue(chain);
};

describe('scheduler: startup summarizer skips right after a sweep', () => {
  let runSpy;
  beforeEach(() => {
    jest.useFakeTimers();
    AgentEvent.findOne.mockReset();
    runSpy = jest.spyOn(SchedulerService, 'runSummarizer').mockResolvedValue({});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    scheduler.stop();
    cron.schedule.mockClear();
    logOutboundFailure.mockClear();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const bootAndWait = async () => {
    scheduler.start();
    await jest.advanceTimersByTimeAsync(5001);
  };

  it('does not sweep when the last sweep was 10 minutes ago, and logs how long ago', async () => {
    newestRow(10 * MIN);
    await bootAndWait();
    expect(runSpy).not.toHaveBeenCalled();
    const skipLine = console.log.mock.calls.map((c) => c.join(' ')).find((l) => /skipping startup summarizer/i.test(l));
    expect(skipLine).toMatch(/10 min/);
  });

  it('queries the newest hourly summary.request', async () => {
    newestRow(10 * MIN);
    await bootAndWait();
    expect(AgentEvent.findOne).toHaveBeenCalledWith({
      agentName: 'commonly-bot',
      type: 'summary.request',
      'payload.trigger': 'scheduled-hourly',
    });
  });

  it('sweeps when the last sweep was 2 hours ago', async () => {
    newestRow(120 * MIN);
    await bootAndWait();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('sweeps when there is no prior sweep', async () => {
    newestRow(null);
    await bootAndWait();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('fails open and logs when the check throws', async () => {
    AgentEvent.findOne.mockImplementation(() => { throw new Error('db down'); });
    await bootAndWait();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(logOutboundFailure).toHaveBeenCalled();
  });

  it('the hourly cron still sweeps right after a sweep', async () => {
    newestRow(1 * MIN);
    scheduler.start();
    const hourly = cron.schedule.mock.results.map((r) => r.value).find((j) => j.expression === '0 * * * *');
    await hourly.fn();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(AgentEvent.findOne).not.toHaveBeenCalled();
  });
});
