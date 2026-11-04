// The run content window unsets stored run content, so the scheduler may only
// register it once the deployment opts in with exactly AGENT_RUN_CONTENT_WINDOW=true
// (after a dry run has counted what it would redact).
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, task, options) => ({
    expression, task, options, start: jest.fn(), stop: jest.fn(),
  })),
}));
jest.mock('../../../services/agentRunContentWindow', () => ({
  redactExpiredRunContent: jest.fn(async () => ({ cutoff: new Date(0), matched: 0, redacted: 0 })),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

const WINDOW_SCHEDULE = '23 4 * * *';
const windowJobs = () => cron.schedule.mock.results
  .map((r) => r.value)
  .filter((job) => job.expression === WINDOW_SCHEDULE);
const windowJobStarted = () => windowJobs().some((job) => job.start.mock.calls.length > 0);

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

  // node-cron starts a task at creation unless it is told not to, which would
  // run the job with the flag unset no matter what start() registers.
  it('creates the window job stopped', () => {
    delete process.env.AGENT_RUN_CONTENT_WINDOW;
    scheduler.start();
    expect(windowJobs()).toHaveLength(1);
    expect(windowJobs()[0].options).toMatchObject({ scheduled: false });
  });

  it('the job applies the redaction, not a dry run', async () => {
    const { redactExpiredRunContent } = require('../../../services/agentRunContentWindow');
    redactExpiredRunContent.mockClear();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.env.AGENT_RUN_CONTENT_WINDOW = 'true';
      scheduler.start();
      // Starting the scheduler (a deploy) must not redact; only the cron tick does.
      expect(redactExpiredRunContent).not.toHaveBeenCalled();
      await windowJobs()[0].task();
      expect(redactExpiredRunContent).toHaveBeenCalledTimes(1);
      expect(redactExpiredRunContent).toHaveBeenCalledWith({ apply: true });
    } finally {
      log.mockRestore();
    }
  });
});
