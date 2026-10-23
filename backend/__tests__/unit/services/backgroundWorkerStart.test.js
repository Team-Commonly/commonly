const { startBackgroundServices } = require('../../../services/backgroundWorkerStart');

describe('background worker start gate', () => {
  let scheduler;
  let discordGateway;

  beforeEach(() => {
    scheduler = { start: jest.fn() };
    discordGateway = { start: jest.fn() };
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['unset', undefined, true],
    ['on', '1', true],
    ['off', '0', false],
  ])('RUN_WORKER %s', (_label, runWorker, shouldStart) => {
    const env = { NODE_ENV: 'production', DISCORD_BOT_TOKEN: 'token' };
    if (runWorker !== undefined) env.RUN_WORKER = runWorker;

    expect(startBackgroundServices(env, { scheduler, discordGateway })).toBe(shouldStart);
    expect(scheduler.start).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
    expect(discordGateway.start).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
  });

  test('keeps the test environment and tokenless gateway stopped', () => {
    expect(startBackgroundServices({ NODE_ENV: 'test', DISCORD_BOT_TOKEN: 'token' }, { scheduler, discordGateway })).toBe(false);
    expect(startBackgroundServices({ NODE_ENV: 'production' }, { scheduler, discordGateway })).toBe(true);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(discordGateway.start).not.toHaveBeenCalled();
  });
});
