// F681: the prod backend logs `[loop-lag]` stalls of 1–4 s at times nobody can
// predict, and the signal profiler only runs when an operator times a signal.
// This profiler runs behind LOOP_STALL_PROFILE=1 in rolling windows and keeps
// only the windows around a stall. These tests pin that it is inert when off,
// what it keeps and discards, its file names and log line, that it stops by
// itself, retention, that a failure is logged once and never thrown, and that
// it ignores the signal profiler's flag. That the two can run together is not
// provable with fakes: two real inspector sessions, both calling
// Profiler.start, were checked by hand on Node 22 and 26 to profile
// independently, each with its own sampling interval.
const path = require('path');
const {
  startLoopStallProfiler,
  parseWindowSeconds,
  parseThresholdMs,
  SAMPLING_INTERVAL_US,
} = require('../../../services/loopStallProfiler');

const DIR = '/profiles';
const T0 = Date.parse('2026-11-25T10:04:00.000Z');
const MS = 1e6; // histogram values are nanoseconds

const fakeFs = () => {
  const files = new Map();
  return {
    files,
    mkdir: jest.fn(async () => undefined),
    writeFile: jest.fn(async (file, data) => { files.set(file, data); }),
    readdir: jest.fn(async () => [...files.keys()].map((f) => path.basename(f))),
    unlink: jest.fn(async (file) => { files.delete(file); }),
  };
};

// Each Profiler.stop returns a profile tagged with its window number, so a test
// can tell which window landed in which file.
const fakeSession = ({ failOn } = {}) => {
  const calls = [];
  let window = 0;
  return {
    calls,
    connect: jest.fn(),
    disconnect: jest.fn(),
    post: jest.fn((method, params, cb) => {
      const done = typeof params === 'function' ? params : cb;
      calls.push(typeof params === 'function' ? method : [method, params]);
      if (failOn === method) return done(new Error(`${method} failed`));
      if (method === 'Profiler.stop') {
        window += 1;
        return done(null, { profile: { window, nodes: [{ id: 1 }], startTime: 0, endTime: 1 } });
      }
      return done(null, {});
    }),
  };
};

const fakeHistogram = () => ({
  max: 0,
  enable: jest.fn(),
  disable: jest.fn(),
  reset: jest.fn(function reset() { this.max = 0; }),
});

const fakeLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

const setup = ({ env = {}, session = fakeSession(), fs = fakeFs() } = {}) => {
  const logger = fakeLogger();
  const histogram = fakeHistogram();
  const createSession = jest.fn(() => session);
  const createHistogram = jest.fn(() => histogram);
  const handle = startLoopStallProfiler({
    env: { LOOP_STALL_PROFILE: '1', LOOP_STALL_PROFILE_DIR: DIR, ...env },
    createSession,
    createHistogram,
    fs,
    logger,
  });
  return { logger, histogram, createSession, createHistogram, session, fs, handle };
};

// Runs one window of `seconds` with the loop delay seen during it. The extra
// millisecond is the window end's one-yield step: a fake setImmediate queued
// from inside a fake timer runs 1 ms later. So each window ends 1 ms after
// the previous one plus its length (window N ends at N * (length + 1 ms)).
const runWindow = async (histogram, maxMs, seconds = 60) => {
  histogram.max = maxMs * MS;
  await jest.advanceTimersByTimeAsync(seconds * 1000 + 1);
};

const written = (fs) => fs.writeFile.mock.calls.map(([file, data]) => [path.basename(file), JSON.parse(data).window]);
const starts = (session) => session.calls.filter((c) => c === 'Profiler.start').length;

describe('startLoopStallProfiler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('creates no session, histogram or timer when the flag is off', async () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      const createSession = jest.fn();
      const createHistogram = jest.fn();
      const handle = startLoopStallProfiler({
        env: { LOOP_STALL_PROFILE: value },
        createSession,
        createHistogram,
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(createHistogram).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      handle.stop();
    }
  });

  it('when on, sets a 10 ms sampling interval before starting the profiler', async () => {
    const { session, histogram, logger, handle } = setup();
    await jest.advanceTimersByTimeAsync(0);
    expect(SAMPLING_INTERVAL_US).toBe(10000);
    expect(session.connect).toHaveBeenCalledTimes(1);
    expect(session.calls).toEqual([
      'Profiler.enable',
      ['Profiler.setSamplingInterval', { interval: 10000 }],
      'Profiler.start',
    ]);
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      '[loop-stall-profile] started, window=%ds threshold=%dms, writing stalls to %s', 60, 1000, DIR,
    );
    handle.stop();
  });

  it('a quiet window writes nothing and starts the next window', async () => {
    const { session, histogram, fs, logger, handle } = setup();
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 999);
    expect(session.calls).toContain('Profiler.stop');
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(starts(session)).toBe(2);
    expect(histogram.reset).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    handle.stop();
  });

  it('a stall window writes the previous and current profiles, with the names and log line', async () => {
    const { histogram, fs, logger, handle } = setup();
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 10); // window 1, quiet: becomes "previous"
    await runWindow(histogram, 4100); // window 2, stall

    const stamp = '2026-11-25T10-06-00-002Z';
    expect(written(fs)).toEqual([
      [`stall-${stamp}-prev.cpuprofile`, 1],
      [`stall-${stamp}-cur.cpuprofile`, 2],
    ]);
    expect(fs.mkdir).toHaveBeenCalledWith(DIR, { recursive: true });
    expect(path.dirname(fs.writeFile.mock.calls[0][0])).toBe(DIR);
    expect(logger.log).toHaveBeenCalledWith(
      '[loop-stall-profile] saved %s max=%dms',
      `${path.join(DIR, `stall-${stamp}-prev.cpuprofile`)} ${path.join(DIR, `stall-${stamp}-cur.cpuprofile`)}`,
      4100,
    );
    handle.stop();
  });

  it('a threshold-exact window counts as a stall', async () => {
    const { histogram, fs, handle } = setup({ env: { LOOP_STALL_PROFILE_THRESHOLD_MS: '1500' } });
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 1499);
    expect(fs.writeFile).not.toHaveBeenCalled();
    await runWindow(histogram, 1500);
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('a stall in the first window, with no previous, writes only the current profile', async () => {
    const { histogram, fs, logger, handle } = setup();
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 2000);
    const stamp = '2026-11-25T10-05-00-001Z';
    expect(written(fs)).toEqual([[`stall-${stamp}-cur.cpuprofile`, 1]]);
    expect(logger.log).toHaveBeenCalledWith(
      '[loop-stall-profile] saved %s max=%dms', path.join(DIR, `stall-${stamp}-cur.cpuprofile`), 2000,
    );
    handle.stop();
  });

  it('stops for good after the max number of saved stalls', async () => {
    const { session, histogram, fs, logger } = setup({ env: { LOOP_STALL_PROFILE_MAX_SAVES: '2' } });
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 1200);
    await runWindow(histogram, 1200);
    expect(logger.log).toHaveBeenCalledWith('[loop-stall-profile] stopped: saved %d stalls, the limit', 2);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(starts(session)).toBe(2);
    const writes = fs.writeFile.mock.calls.length;

    await runWindow(histogram, 5000);
    await runWindow(histogram, 5000);
    expect(fs.writeFile).toHaveBeenCalledTimes(writes);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops for good after the hours limit', async () => {
    const { session, histogram, fs, logger } = setup({
      env: { LOOP_STALL_PROFILE_HOURS: '1', LOOP_STALL_PROFILE_WINDOW_S: '60' },
    });
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 59; i += 1) await runWindow(histogram, 0, 60);
    expect(session.disconnect).not.toHaveBeenCalled();
    await runWindow(histogram, 0, 60); // 60 minutes in
    expect(logger.log).toHaveBeenCalledWith('[loop-stall-profile] stopped: ran %dh, the limit', 1);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await runWindow(histogram, 5000, 60);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('keeps at most six stall files and never touches cpu-* or other files', async () => {
    const fs = fakeFs();
    const cpu = path.join(DIR, 'cpu-2026-11-01T00-00-00-000Z.cpuprofile');
    fs.files.set(cpu, '{}');
    fs.files.set(path.join(DIR, 'unrelated.txt'), 'keep me');
    const { histogram, handle } = setup({ fs, env: { LOOP_STALL_PROFILE_MAX_SAVES: '10' } });
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 0);
    for (let i = 0; i < 4; i += 1) {
      await runWindow(histogram, 0); // quiet window becomes previous
      await runWindow(histogram, 3000); // stall writes two files
    }
    const stalls = [...fs.files.keys()].map((f) => path.basename(f)).filter((f) => f.startsWith('stall-')).sort();
    expect(stalls).toHaveLength(6);
    const all = fs.writeFile.mock.calls.map(([f]) => path.basename(f)).sort();
    expect(stalls).toEqual(all.slice(2));
    expect(fs.files.has(cpu)).toBe(true);
    expect(fs.files.has(path.join(DIR, 'unrelated.txt'))).toBe(true);
    handle.stop();
  });

  it('a session error logs once, stops the profiler and never throws', async () => {
    const session = fakeSession({ failOn: 'Profiler.stop' });
    const { histogram, logger, fs } = setup({ session });
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 3000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '%s',
      '[loop-stall-profile] failed, profiler stopped',
      expect.objectContaining({ message: 'Profiler.stop failed' }),
    );
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await runWindow(histogram, 3000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('a session that fails to connect logs once and stops, never throws', async () => {
    const session = fakeSession();
    session.connect.mockImplementation(() => { throw new Error('inspector busy'); });
    let result;
    expect(() => { result = setup({ session }); }).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    expect(result.logger.error).toHaveBeenCalledTimes(1);
    expect(result.logger.error).toHaveBeenCalledWith(
      '%s', '[loop-stall-profile] failed, profiler stopped', expect.objectContaining({ message: 'inspector busy' }),
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a failed write logs once and stops the profiler', async () => {
    const fs = fakeFs();
    fs.writeFile.mockImplementation(async () => { throw new Error('ENOSPC'); });
    const { histogram, logger, session } = setup({ fs });
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 3000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '%s', '[loop-stall-profile] failed, profiler stopped', expect.objectContaining({ message: 'ENOSPC' }),
    );
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("ignores the signal profiler's flag", async () => {
    const { createSession, session, handle } = setup({ env: { CPU_PROFILE_ON_SIGNAL: '1' } });
    await jest.advanceTimersByTimeAsync(0);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(session.calls).toContain('Profiler.start');
    handle.stop();
  });

  it('reads the histogram after one yield, so a delay recorded by a timer due at the boundary counts', async () => {
    const { histogram, fs, handle } = setup();
    await jest.advanceTimersByTimeAsync(0);
    // Created after the window timer and due at the same moment, so it runs
    // just after it, as the histogram's own timer can.
    setTimeout(() => { histogram.max = 2000 * MS; }, 60_000);
    await jest.advanceTimersByTimeAsync(60_001);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('resets the histogram in the same tick as Profiler.stop and before Profiler.start', async () => {
    const session = fakeSession();
    const order = [];
    const { histogram, handle } = setup({ session });
    await jest.advanceTimersByTimeAsync(0);
    session.post.mockClear();
    session.post.mockImplementation((method, params, cb) => {
      const done = typeof params === 'function' ? params : cb;
      order.push(method);
      return done(null, method === 'Profiler.stop' ? { profile: {} } : {});
    });
    histogram.reset.mockImplementation(() => { order.push('reset'); });
    await runWindow(histogram, 0);
    expect(order).toEqual(['Profiler.stop', 'reset', 'Profiler.start']);
    handle.stop();
  });

  it('a failed prune logs and the profiler keeps running', async () => {
    const fs = fakeFs();
    for (let i = 0; i < 6; i += 1) {
      fs.files.set(path.join(DIR, `stall-2026-11-01T00-00-0${i}-000Z-cur.cpuprofile`), '{}');
    }
    fs.unlink.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    const { histogram, logger, session, handle } = setup({ fs });
    await jest.advanceTimersByTimeAsync(0);
    await runWindow(histogram, 3000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '%s', '[loop-stall-profile] pruning old profiles failed', expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(session.disconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    await runWindow(histogram, 0);
    expect(starts(session)).toBe(3);
    handle.stop();
  });

  it('stop() ends the window, disconnects and writes nothing', async () => {
    const { session, histogram, fs, handle } = setup();
    await jest.advanceTimersByTimeAsync(0);
    handle.stop();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await runWindow(histogram, 5000);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('uses the clamped window length for its timer', async () => {
    const { session, histogram, handle } = setup({ env: { LOOP_STALL_PROFILE_WINDOW_S: '5' } });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(9999);
    expect(session.calls).not.toContain('Profiler.stop');
    histogram.max = 0;
    await jest.advanceTimersByTimeAsync(2);
    expect(session.calls).toContain('Profiler.stop');
    handle.stop();
  });
});

describe('env parsing', () => {
  it('window defaults to 60 and clamps to 10..60', () => {
    for (const raw of [undefined, '', 'abc', 'Infinity']) expect(parseWindowSeconds(raw)).toBe(60);
    expect(parseWindowSeconds('1')).toBe(10);
    expect(parseWindowSeconds('-5')).toBe(10);
    expect(parseWindowSeconds('30')).toBe(30);
    expect(parseWindowSeconds('600')).toBe(60);
  });

  it('threshold defaults to 1000 and clamps to 100..60000', () => {
    for (const raw of [undefined, '', 'abc']) expect(parseThresholdMs(raw)).toBe(1000);
    expect(parseThresholdMs('0')).toBe(100);
    expect(parseThresholdMs('50')).toBe(100);
    expect(parseThresholdMs('2500')).toBe(2500);
    expect(parseThresholdMs('999999')).toBe(60000);
  });
});

// Why the reset sits in the same tick as Profiler.stop: a real histogram's
// reset() also drops the interval in progress, so a synchronous pause just
// before it (our own stop/start) is not counted as a stall, while the same
// pause left to the next timer yield is.
describe('a real monitorEventLoopDelay histogram', () => {
  const { monitorEventLoopDelay } = require('perf_hooks');
  const block = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* busy */ } };
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

  it('does not count a synchronous block followed by reset() in the same tick', async () => {
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    try {
      await wait(100);
      block(300);
      h.reset();
      await wait(100);
      expect(h.max / MS).toBeLessThan(200);
    } finally {
      h.disable();
    }
  });

  it('counts the same block once a timer yield comes before the reset', async () => {
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    try {
      await wait(100);
      block(300);
      await wait(50);
      expect(h.max / MS).toBeGreaterThanOrEqual(290);
    } finally {
      h.disable();
    }
  });
});
