// The synthetic-account purge deletes rows, so the scheduler may only register
// it when the deployment opts in with exactly SYNTHETIC_ACCOUNT_PURGE=true.
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression) => ({ expression, start: jest.fn(), stop: jest.fn() })),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

const PURGE_SCHEDULE = '47 2,14 * * *';
const purgeJobStarted = () => cron.schedule.mock.results
  .map((r) => r.value)
  .filter((job) => job.expression === PURGE_SCHEDULE)
  .some((job) => job.start.mock.calls.length > 0);

describe('scheduler: synthetic-account purge opt-in', () => {
  const original = process.env.SYNTHETIC_ACCOUNT_PURGE;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    scheduler.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    cron.schedule.mockClear();
    if (original === undefined) delete process.env.SYNTHETIC_ACCOUNT_PURGE;
    else process.env.SYNTHETIC_ACCOUNT_PURGE = original;
  });

  it.each([undefined, 'false', 'TRUE', '1'])('does not start the purge job when the flag is %p', (value) => {
    if (value === undefined) delete process.env.SYNTHETIC_ACCOUNT_PURGE;
    else process.env.SYNTHETIC_ACCOUNT_PURGE = value;
    scheduler.start();
    expect(purgeJobStarted()).toBe(false);
  });

  it('starts the purge job only when the flag is exactly "true"', () => {
    process.env.SYNTHETIC_ACCOUNT_PURGE = 'true';
    scheduler.start();
    expect(purgeJobStarted()).toBe(true);
  });
});
