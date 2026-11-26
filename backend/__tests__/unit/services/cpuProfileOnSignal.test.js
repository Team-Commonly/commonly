// F633: the prod backend stalls its loop for seconds at :04/:14/:24 and the
// logs can't say what burns the CPU. An operator captures a CPU profile from
// the host with `docker kill -s USR2` and fetches it with `docker cp`. These
// tests pin that the handler exists only behind the flag (nodemon restarts
// the dev server with SIGUSR2), that one capture runs at a time, where the
// file lands, retention, and that a failure is logged and never thrown.
const { EventEmitter } = require('events');
const path = require('path');
const {
  startCpuProfileOnSignal,
  parseProfileSeconds,
} = require('../../../services/cpuProfileOnSignal');

const DIR = '/profiles';

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

const fakeSession = ({ stopFails = false } = {}) => {
  const calls = [];
  return {
    calls,
    connect: jest.fn(),
    disconnect: jest.fn(),
    post: jest.fn((method, params, cb) => {
      const done = typeof params === 'function' ? params : cb;
      calls.push(method);
      if (method === 'Profiler.stop') {
        if (stopFails) return done(new Error('stop failed'));
        return done(null, { profile: { nodes: [{ id: 1 }], startTime: 0, endTime: 1 } });
      }
      return done(null, {});
    }),
  };
};

const fakeLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

// Each tick advances the clock a second so every file gets its own name.
const clock = () => {
  let t = Date.parse('2026-11-25T10:04:00.000Z');
  return () => { const d = new Date(t); t += 1000; return d; };
};

const setup = ({ env = {}, sessions, fs = fakeFs() } = {}) => {
  const proc = new EventEmitter();
  const logger = fakeLogger();
  const queue = sessions || [];
  const createSession = jest.fn(() => queue.shift() || fakeSession());
  const handle = startCpuProfileOnSignal({
    env: { CPU_PROFILE_ON_SIGNAL: '1', CPU_PROFILE_DIR: DIR, ...env },
    proc,
    createSession,
    fs,
    logger,
    now: clock(),
  });
  return { proc, logger, createSession, fs, handle };
};

describe('startCpuProfileOnSignal', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('adds no SIGUSR2 listener when the flag is off', () => {
    const proc = new EventEmitter();
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      const handle = startCpuProfileOnSignal({ env: { CPU_PROFILE_ON_SIGNAL: value }, proc });
      expect(proc.listenerCount('SIGUSR2')).toBe(0);
      handle.stop();
    }
    expect(proc.eventNames()).toEqual([]);
  });

  it('adds exactly one SIGUSR2 listener when the flag is on, never SIGUSR1, and stop() removes it', () => {
    const { proc, handle } = setup();
    expect(proc.listenerCount('SIGUSR2')).toBe(1);
    expect(proc.listenerCount('SIGUSR1')).toBe(0);
    handle.stop();
    expect(proc.listenerCount('SIGUSR2')).toBe(0);
  });

  it('a signal starts the profiler, and after the configured seconds stops it and writes one file', async () => {
    const session = fakeSession();
    const { proc, fs, logger, handle } = setup({ env: { CPU_PROFILE_SECONDS: '10' }, sessions: [session] });

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(0);
    expect(session.connect).toHaveBeenCalledTimes(1);
    expect(session.calls).toEqual(['Profiler.enable', 'Profiler.start']);
    expect(fs.writeFile).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(9999);
    expect(session.calls).not.toContain('Profiler.stop');

    await jest.advanceTimersByTimeAsync(1);
    expect(session.calls).toContain('Profiler.stop');
    expect(fs.mkdir).toHaveBeenCalledWith(DIR, { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [file, data] = fs.writeFile.mock.calls[0];
    expect(path.dirname(file)).toBe(DIR);
    expect(path.basename(file)).toMatch(/^cpu-2026-11-25T10-04-\d{2}-\d{3}Z\.cpuprofile$/);
    expect(JSON.parse(data).nodes).toEqual([{ id: 1 }]);
    expect(session.disconnect).toHaveBeenCalledTimes(1);

    // One start line and one finish line, fixed format, values as data.
    expect(logger.log).toHaveBeenCalledWith('[cpu-profile] started, %ds, writing to %s', 10, DIR);
    expect(logger.log).toHaveBeenCalledWith(
      '[cpu-profile] wrote %s (%d bytes, %ds)', file, Buffer.byteLength(data), 10,
    );
    expect(logger.error).not.toHaveBeenCalled();
    handle.stop();
  });

  it('ignores and logs a second signal during a capture', async () => {
    const first = fakeSession();
    const { proc, logger, createSession, fs, handle } = setup({ sessions: [first] });

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(0);
    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(0);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[cpu-profile] a capture is already running; signal ignored');

    await jest.advanceTimersByTimeAsync(30000);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);

    // Once finished, the next signal captures again.
    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(30000);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('keeps at most five files, pruning the oldest', async () => {
    const fs = fakeFs();
    fs.files.set(path.join(DIR, 'unrelated.txt'), 'keep me');
    const { proc, handle } = setup({ env: { CPU_PROFILE_SECONDS: '5' }, fs });

    const written = [];
    for (let i = 0; i < 6; i += 1) {
      proc.emit('SIGUSR2');
      await jest.advanceTimersByTimeAsync(5000);
      written.push(fs.writeFile.mock.calls[i][0]);
    }

    const profiles = [...fs.files.keys()].filter((f) => f.endsWith('.cpuprofile'));
    expect(profiles).toHaveLength(5);
    expect(profiles).not.toContain(written[0]);
    expect(profiles.sort()).toEqual(written.slice(1).sort());
    expect(fs.files.has(path.join(DIR, 'unrelated.txt'))).toBe(true);
    handle.stop();
  });

  it('logs a failing Profiler.stop, never throws, and the next signal works', async () => {
    const { proc, fs, logger, handle } = setup({
      sessions: [fakeSession({ stopFails: true }), fakeSession()],
    });

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(30000);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '%s', '[cpu-profile] capture failed', expect.objectContaining({ message: 'stop failed' }),
    );

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(30000);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('logs a failing write, never throws, and the next signal works', async () => {
    const fs = fakeFs();
    const realWrite = fs.writeFile.getMockImplementation();
    fs.writeFile.mockImplementationOnce(async () => { throw new Error('ENOSPC'); });
    fs.writeFile.mockImplementation(realWrite);
    const { proc, logger, handle } = setup({ fs });

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(30000);
    expect(logger.error).toHaveBeenCalledWith(
      '%s', '[cpu-profile] capture failed', expect.objectContaining({ message: 'ENOSPC' }),
    );
    expect(fs.files.size).toBe(0);

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(30000);
    expect(fs.files.size).toBe(1);
    handle.stop();
  });

  it('logs a session that fails to connect, and stays ready for the next signal', async () => {
    const broken = fakeSession();
    broken.connect.mockImplementation(() => { throw new Error('inspector busy'); });
    const { proc, logger, fs, handle } = setup({ sessions: [broken, fakeSession()] });

    expect(() => proc.emit('SIGUSR2')).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(
      '%s', '[cpu-profile] capture failed', expect.objectContaining({ message: 'inspector busy' }),
    );

    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(30000);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('stop() during a capture cancels it and disconnects the session', async () => {
    const session = fakeSession();
    const { proc, fs, handle } = setup({ sessions: [session] });
    proc.emit('SIGUSR2');
    await jest.advanceTimersByTimeAsync(0);
    handle.stop();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60000);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('parseProfileSeconds', () => {
  it('defaults to 30 for a missing or non-numeric value', () => {
    for (const raw of [undefined, '', 'abc', 'NaN', 'Infinity']) {
      expect(parseProfileSeconds(raw)).toBe(30);
    }
  });

  it('clamps to 5..60', () => {
    expect(parseProfileSeconds('1')).toBe(5);
    expect(parseProfileSeconds('0')).toBe(5);
    expect(parseProfileSeconds('-10')).toBe(5);
    expect(parseProfileSeconds('5')).toBe(5);
    expect(parseProfileSeconds('45')).toBe(45);
    expect(parseProfileSeconds('60')).toBe(60);
    expect(parseProfileSeconds('600')).toBe(60);
  });
});
