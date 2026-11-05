// F183: the PG mirror repair runs nightly at 03:30 UTC, registered only when the
// deployment opts in with exactly PG_MIRROR_REPAIR=true. Whether it applies
// repairs is a second, separate flag the service reads itself
// (PG_MIRROR_REPAIR_APPLY=1); the scheduler never passes an apply switch.
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, task, options) => ({
    expression, task, options, start: jest.fn(), stop: jest.fn(),
  })),
}));
jest.mock('../../../services/pgMirrorRepairService', () => ({
  runPgMirrorRepair: jest.fn(async () => ({ applied: false, counts: {}, alerts: [] })),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

const SCHEDULE = '30 3 * * *';
const jobs = () => cron.schedule.mock.results.map((r) => r.value).filter((job) => job.expression === SCHEDULE);
const started = () => jobs().some((job) => job.start.mock.calls.length > 0);

describe('scheduler: PG mirror repair opt-in (F183)', () => {
  const original = process.env.PG_MIRROR_REPAIR;
  afterEach(() => {
    scheduler.stop();
    cron.schedule.mockClear();
    if (original === undefined) delete process.env.PG_MIRROR_REPAIR;
    else process.env.PG_MIRROR_REPAIR = original;
  });

  it.each([undefined, 'false', 'TRUE', '1'])('does not start the repair job when the flag is %p', (value) => {
    if (value === undefined) delete process.env.PG_MIRROR_REPAIR;
    else process.env.PG_MIRROR_REPAIR = value;
    scheduler.start();
    expect(started()).toBe(false);
  });

  it('starts the repair job at 03:30 UTC only when the flag is exactly "true"', () => {
    process.env.PG_MIRROR_REPAIR = 'true';
    scheduler.start();
    expect(started()).toBe(true);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].options).toMatchObject({ scheduled: false, timezone: 'UTC' });
  });

  it('the tick calls the service with no apply switch, and a failure does not throw out of the tick', async () => {
    const { runPgMirrorRepair } = require('../../../services/pgMirrorRepairService');
    runPgMirrorRepair.mockClear();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.PG_MIRROR_REPAIR = 'true';
      scheduler.start();
      expect(runPgMirrorRepair).not.toHaveBeenCalled();
      await jobs()[0].task();
      expect(runPgMirrorRepair).toHaveBeenCalledWith();
      runPgMirrorRepair.mockRejectedValueOnce(new Error('pg down'));
      await expect(jobs()[0].task()).resolves.toBeUndefined();
      expect(err).toHaveBeenCalledWith(expect.stringContaining('[pg-mirror-repair]'), expect.anything());
    } finally {
      err.mockRestore();
    }
  });
});
