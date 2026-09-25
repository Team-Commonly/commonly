/**
 * TASK-168 — the boot-time PG connect must not be decided once.
 *
 * The production failure this covers: a transient connect timeout at startup
 * left the pod without the PG routes for its whole life, and nothing retried.
 * Every one of these cases therefore turns on the same question — does a
 * FAILED early attempt still lead to a mounted route later, and does a
 * successful one mount exactly once.
 *
 * The clock, the scheduler, the connector and the initializer are all injected,
 * so these run in milliseconds and assert the retry SHAPE (how many attempts,
 * what delay between them) rather than just the end state.
 */
const { createPgBoot } = require('../../../services/pgBootService');

const makeState = () => ({
  mounted: false,
  attempts: 0,
  fellBack: false,
  lastError: null,
  mountedAt: null,
});

const silentLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const build = (overrides = {}) => {
  const state = overrides.state || makeState();
  const mountRoutes = overrides.mountRoutes || jest.fn();
  const sleep = overrides.sleep || jest.fn().mockResolvedValue(undefined);
  const scheduled = [];
  const schedule = overrides.schedule || jest.fn((fn, ms) => {
    scheduled.push({ fn, ms });
    return jest.fn();
  });
  const boot = createPgBoot({
    mountRoutes,
    connect: overrides.connect || jest.fn().mockResolvedValue({ pool: true }),
    initialize: overrides.initialize || jest.fn().mockResolvedValue(true),
    onMounted: overrides.onMounted,
    sleep,
    schedule,
    log: silentLog,
    state,
    attempts: overrides.attempts || 3,
    baseDelayMs: overrides.baseDelayMs || 100,
    maxDelayMs: overrides.maxDelayMs || 250,
    backgroundIntervalMs: overrides.backgroundIntervalMs || 30000,
  });
  return { boot, state, mountRoutes, sleep, schedule, scheduled };
};

describe('pgBootService — boot connect retries (TASK-168)', () => {
  afterEach(() => jest.clearAllMocks());

  it('makes the first connect time out and mounts the routes on the second attempt', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce({ pool: true });
    const initialize = jest.fn().mockResolvedValue(true);
    const { boot, state, mountRoutes, sleep, schedule } = build({ connect, initialize });

    const mounted = await boot.start();

    expect(mounted).toBe(true);
    expect(state.attempts).toBe(2);
    expect(state.mounted).toBe(true);
    expect(mountRoutes).toHaveBeenCalledTimes(1);
    // The timeout is a failed attempt, not a reason to give up: one backoff,
    // no background fallback.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(schedule).not.toHaveBeenCalled();
    expect(state.fellBack).toBe(false);
    expect(state.lastError).toBeNull();
  });

  it('mounts nothing when every boot attempt fails, then mounts on a background retry', async () => {
    const connect = jest.fn().mockResolvedValue(null);
    const { boot, state, mountRoutes, scheduled } = build({ connect, attempts: 3 });

    const mounted = await boot.start();

    expect(mounted).toBe(false);
    expect(state.attempts).toBe(3);
    expect(state.mounted).toBe(false);
    expect(mountRoutes).not.toHaveBeenCalled();
    expect(state.fellBack).toBe(true);
    expect(state.lastError).toBe('connect returned no pool');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(30000);

    // PG comes back. This is the half that was missing in production: the pod
    // must register the routes without a restart.
    connect.mockResolvedValue({ pool: true });
    scheduled[0].fn();
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(state.mounted).toBe(true);
    expect(mountRoutes).toHaveBeenCalledTimes(1);
    expect(state.attempts).toBe(4);
    expect(state.lastError).toBeNull();
  });

  it('does not mount the routes until the schema has been applied', async () => {
    const initialize = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { boot, state, mountRoutes } = build({ initialize, attempts: 2 });

    await boot.start();

    expect(mountRoutes).toHaveBeenCalledTimes(1);
    expect(state.mounted).toBe(true);
    expect(state.attempts).toBe(2);
  });

  it('backs off exponentially and caps the wait at maxDelayMs', async () => {
    const { boot, sleep } = build({
      connect: jest.fn().mockResolvedValue(null),
      attempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 250,
    });

    await boot.start();

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 250]);
  });

  it('mounts exactly once when a background retry succeeds more than once', async () => {
    const connect = jest.fn().mockResolvedValue(null);
    const { boot, state, mountRoutes, scheduled } = build({ connect, attempts: 1 });

    await boot.start();
    connect.mockResolvedValue({ pool: true });

    scheduled[0].fn();
    await new Promise((resolve) => { setImmediate(resolve); });
    const mountedAt = state.mountedAt;

    scheduled[0].fn();
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(mountRoutes).toHaveBeenCalledTimes(1);
    expect(state.attempts).toBe(3);
    expect(state.mountedAt).toBe(mountedAt);
  });

  it('treats a throwing connector as a failed attempt rather than a boot crash', async () => {
    const connect = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { boot, state } = build({ connect, attempts: 2 });

    await expect(boot.start()).resolves.toBe(false);

    expect(state.attempts).toBe(2);
    expect(state.lastError).toBe('connect threw: ECONNRESET');
    expect(state.mounted).toBe(false);
  });

  it('runs the post-mount work only on a successful mount', async () => {
    const onMounted = jest.fn();
    const failed = build({ connect: jest.fn().mockResolvedValue(null), attempts: 1, onMounted });
    await failed.boot.start();
    expect(onMounted).not.toHaveBeenCalled();

    const ok = build({ onMounted });
    await ok.boot.start();
    expect(onMounted).toHaveBeenCalledTimes(1);
  });

  it('stops the background retry timer once the connection succeeds', async () => {
    const cancel = jest.fn();
    const connect = jest.fn().mockResolvedValue(null);
    const { boot, scheduled } = build({
      connect,
      attempts: 1,
      schedule: jest.fn((fn, ms) => { scheduled.push({ fn, ms }); return cancel; }),
    });

    await boot.start();
    connect.mockResolvedValue({ pool: true });
    scheduled[0].fn();
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
