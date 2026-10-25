jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, tick) => ({ expression, tick, start: jest.fn(), stop: jest.fn() })),
}));
jest.mock('../../../services/assignedTaskWakeService', () => ({
  dispatchAssignedTaskWakes: jest.fn().mockResolvedValue({ eligible: 0, woken: 0 }),
}));
jest.mock('../../../services/playbooks/runner', () => ({
  tickPlaybookSchedules: jest.fn(), reconcilePlaybookRuns: jest.fn(),
}));
const { tickPlaybookSchedules, reconcilePlaybookRuns } = require('../../../services/playbooks/runner');
const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');
const { dispatchAssignedTaskWakes } = require('../../../services/assignedTaskWakeService');

it('starts the assigned-row dispatcher on the one-minute clock and stops it with the scheduler', async () => {
  jest.useFakeTimers();
  const heartbeat = jest.spyOn(scheduler.constructor, 'dispatchScheduledAgentHeartbeats').mockResolvedValue({});
  try {
    scheduler.start();
    const minuteJobs = cron.schedule.mock.results.map((result) => result.value)
      .filter((job) => job.expression === '* * * * *');
    for (const job of minuteJobs) {
      expect(job.start).toHaveBeenCalledTimes(1);
      await job.tick();
    }
    expect(dispatchAssignedTaskWakes).toHaveBeenCalledTimes(1);
    expect(tickPlaybookSchedules).toHaveBeenCalledTimes(1);
    const recovery = cron.schedule.mock.results.map((result) => result.value)
      .find((job) => job.expression === '7,17,27,37,47,57 * * * *');
    expect(recovery.start).toHaveBeenCalledTimes(1);
    await recovery.tick();
    expect(reconcilePlaybookRuns).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(minuteJobs.every((job) => job.stop.mock.calls.length === 1)).toBe(true);
  } finally {
    scheduler.stop();
    heartbeat.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
