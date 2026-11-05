// F184: the parked tool-call job runs two sweeps. Each frees approval slots on
// its own, so a throw in one must not skip the other.
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, fn) => ({
    expression, fn, start: jest.fn(), stop: jest.fn(), 
  })),
}));
const mockSweepExpired = jest.fn();
const mockSweepCardless = jest.fn();
jest.mock('../../../services/approvalActionService', () => ({
  sweepExpiredToolCallApprovals: (...args) => mockSweepExpired(...args),
  sweepCardlessToolCallApprovals: (...args) => mockSweepCardless(...args),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

// Found by what it calls, not by its cron expression, which other jobs share.
const approvalSweepJob = () => {
  const jobs = cron.schedule.mock.results.map((r) => r.value)
    .filter((job) => String(job.fn).includes('sweepCardlessToolCallApprovals'));
  expect(jobs).toHaveLength(1);
  return jobs[0];
};

describe('scheduler: parked tool-call sweeps', () => {
  let errorSpy;
  beforeEach(() => {
    mockSweepExpired.mockReset().mockResolvedValue(0);
    mockSweepCardless.mockReset().mockResolvedValue(0);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    scheduler.start();
  });
  afterEach(() => {
    scheduler.stop();
    cron.schedule.mockClear();
    errorSpy.mockRestore();
  });

  it('runs the cardless sweep when the expiry sweep throws', async () => {
    mockSweepExpired.mockRejectedValue(new Error('expiry down'));
    await approvalSweepJob().fn();
    expect(mockSweepCardless).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/expiry sweep failed/), expect.any(Error));
  });

  it('runs the expiry sweep when the cardless sweep throws, and logs it under its own name', async () => {
    mockSweepCardless.mockRejectedValue(new Error('cardless down'));
    await approvalSweepJob().fn();
    expect(mockSweepExpired).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/cardless sweep failed/), expect.any(Error));
  });
});
