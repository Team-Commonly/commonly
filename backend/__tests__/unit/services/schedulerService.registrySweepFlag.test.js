// The hourly AgentRegistry -> Installable sweep ships off: it runs only when
// INSTALLABLE_REGISTRY_SWEEP=1, so no deploy backfills prod before a backup.
jest.mock('node-cron', () => ({
  ...jest.requireActual('node-cron'),
  schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));
jest.mock('../../../services/installable/registryReconciler', () => ({
  sweepRegistryDrift: jest.fn().mockResolvedValue({
    scanned: 0, inserted: 0, existing: 0, errors: 0, mismatches: { status: 0, stats: 0 },
  }),
}));

const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');
const { sweepRegistryDrift } = require('../../../services/installable/registryReconciler');

const runRegistryJob = async () => {
  cron.schedule.mockClear();
  scheduler.start();
  try {
    const callbacks = cron.schedule.mock.calls.filter(([e]) => e === '39 * * * *').map(([, fn]) => fn);
    expect(callbacks).toHaveLength(1);
    await callbacks[0]();
  } finally {
    scheduler.stop();
  }
};

describe('registry drift sweep flag', () => {
  const saved = process.env.INSTALLABLE_REGISTRY_SWEEP;
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    sweepRegistryDrift.mockClear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INSTALLABLE_REGISTRY_SWEEP;
    else process.env.INSTALLABLE_REGISTRY_SWEEP = saved;
    jest.restoreAllMocks();
  });

  it('does not sweep when the flag is unset, and logs that it skipped', async () => {
    delete process.env.INSTALLABLE_REGISTRY_SWEEP;
    await runRegistryJob();
    expect(sweepRegistryDrift).not.toHaveBeenCalled();
    expect(console.log.mock.calls.some(([m]) => String(m).includes('INSTALLABLE_REGISTRY_SWEEP'))).toBe(true);
  });

  it('does not sweep for a value other than 1', async () => {
    process.env.INSTALLABLE_REGISTRY_SWEEP = 'true';
    await runRegistryJob();
    expect(sweepRegistryDrift).not.toHaveBeenCalled();
  });

  it('sweeps, applying, when the flag is 1', async () => {
    process.env.INSTALLABLE_REGISTRY_SWEEP = '1';
    await runRegistryJob();
    expect(sweepRegistryDrift).toHaveBeenCalledWith({ dryRun: false });
  });
});
