const { startBackgroundServices } = require('../../../services/backgroundWorkerStart');

describe('background worker start gate', () => {
  let scheduler;
  let discordGateway;
  let nativeQueue;

  beforeEach(() => {
    scheduler = { start: jest.fn() };
    discordGateway = { start: jest.fn() };
    nativeQueue = { start: jest.fn() };
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

    expect(startBackgroundServices(env, { scheduler, discordGateway, nativeQueue })).toBe(shouldStart);
    expect(scheduler.start).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
    expect(discordGateway.start).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
  });

  // F52: web pods hand native turns to the worker's queue. Only the dedicated
  // worker reads it; a single-process install runs its turns where they arrive.
  test.each([
    ['unset', undefined, 0],
    ['on', '1', 1],
    ['off', '0', 0],
  ])('the native turn queue with RUN_WORKER %s', (_label, runWorker, starts) => {
    const env = { NODE_ENV: 'production' };
    if (runWorker !== undefined) env.RUN_WORKER = runWorker;

    startBackgroundServices(env, { scheduler, discordGateway, nativeQueue });
    expect(nativeQueue.start).toHaveBeenCalledTimes(starts);
  });

  test('keeps the test environment and tokenless gateway stopped', () => {
    const testEnv = { NODE_ENV: 'test', DISCORD_BOT_TOKEN: 'token', RUN_WORKER: '1' };
    expect(startBackgroundServices(testEnv, { scheduler, discordGateway, nativeQueue })).toBe(false);
    expect(nativeQueue.start).not.toHaveBeenCalled();
    expect(startBackgroundServices({ NODE_ENV: 'production' }, { scheduler, discordGateway, nativeQueue })).toBe(true);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(discordGateway.start).not.toHaveBeenCalled();
  });
});
