// ADR-034 D3: the dual-store repair pass runs every five minutes, always
// registered; repairDualStoredModels itself skips models in mongo or pg.
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, task, options) => ({
    expression, task, options, start: jest.fn(), stop: jest.fn(),
  })),
}));
jest.mock('../../../repositories/dualStoreRegistry', () => ({
  repairDualStoredModels: jest.fn(async () => ({})),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');
const { repairDualStoredModels } = require('../../../repositories/dualStoreRegistry');

const repairJobs = () => cron.schedule.mock.results.map((r) => r.value)
  .filter((job) => String(job.task).includes('dualStoreRegistry'));

describe('scheduler: dual-store repair', () => {
  afterEach(() => {
    scheduler.stop();
    cron.schedule.mockClear();
    jest.restoreAllMocks();
  });

  it('starts one job every five minutes, UTC', () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    scheduler.start();
    expect(repairJobs()).toHaveLength(1);
    const [job] = repairJobs();
    expect(job.expression).toBe('*/5 * * * *');
    expect(job.options).toMatchObject({ scheduled: false, timezone: 'UTC' });
    expect(job.start).toHaveBeenCalled();
  });

  it('the tick runs the pass, and a failure does not throw out of the tick', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    scheduler.start();
    const [job] = repairJobs();
    expect(repairDualStoredModels).not.toHaveBeenCalled();
    await job.task();
    expect(repairDualStoredModels).toHaveBeenCalledWith();
    repairDualStoredModels.mockRejectedValueOnce(new Error('boom'));
    await expect(job.task()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('%s', '[dual-store] scheduled repair failed:', expect.objectContaining({ message: 'boom' }));
  });
});
