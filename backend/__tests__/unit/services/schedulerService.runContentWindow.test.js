// The run content window unsets stored run content, so the scheduler may only
// register it once the deployment opts in with exactly AGENT_RUN_CONTENT_WINDOW=true
// (after a dry run has counted what it would redact).
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression) => ({ expression, start: jest.fn(), stop: jest.fn() })),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

const WINDOW_SCHEDULE = '23 4 * * *';
const windowJobStarted = () => cron.schedule.mock.results
  .map((r) => r.value)
  .filter((job) => job.expression === WINDOW_SCHEDULE)
  .some((job) => job.start.mock.calls.length > 0);

describe('scheduler: run content window opt-in', () => {
  const original = process.env.AGENT_RUN_CONTENT_WINDOW;
  afterEach(() => {
    scheduler.stop();
    cron.schedule.mockClear();
    if (original === undefined) delete process.env.AGENT_RUN_CONTENT_WINDOW;
    else process.env.AGENT_RUN_CONTENT_WINDOW = original;
  });

  it.each([undefined, 'false', 'TRUE', '1'])('does not start the window job when the flag is %p', (value) => {
    if (value === undefined) delete process.env.AGENT_RUN_CONTENT_WINDOW;
    else process.env.AGENT_RUN_CONTENT_WINDOW = value;
    scheduler.start();
    expect(windowJobStarted()).toBe(false);
  });

  it('starts the window job only when the flag is exactly "true"', () => {
    process.env.AGENT_RUN_CONTENT_WINDOW = 'true';
    scheduler.start();
    expect(windowJobStarted()).toBe(true);
  });
});
