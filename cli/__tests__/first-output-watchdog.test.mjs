/**
 * first-output-watchdog.test.mjs — a spawn that never starts is killed early.
 *
 * Seen 2026-10-30: with the Mac's console locked, every launchd seat's
 * `claude -p` turn wrote nothing for the full 45-minute run timeout, then was
 * respawned into the same hang. A healthy turn writes its transcript within a
 * second, so a spawn with no transcript row, stdout or stderr inside the
 * window is killed, named, backed off, and its claim released.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-first-output-test-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => sessionsTmpDir },
  homedir: () => sessionsTmpDir,
}));

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;
const claude = (await import('../src/lib/adapters/claude.js')).default;
const {
  consoleLocked, spawnStalledError, watchFirstOutput, firstOutputWindowMs, DEFAULT_FIRST_OUTPUT_WINDOW_MS, physicalPath,
  killStallSurvivors,
} = await import('../src/lib/first-output-watchdog.js');
const { classifySpawnFailure, spawnRetryPolicy, SPAWN_FAILURE_CLASS } = await import('../src/lib/spawn-retry.js');

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

// A child that closes with 143 once killed, and otherwise does whatever
// `script` makes it do.
const fakeChild = (script = () => {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn(() => { setImmediate(() => proc.emit('close', 143)); });
  setImmediate(() => script(proc));
  return proc;
};

// The child is made inside the spawn seam, so its script cannot run before
// the adapter has attached its listeners.
const spawnClaude = (script, { windowMs, locked = true } = {}) => {
  const saved = process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
  process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = String(windowMs);
  const spawned = {};
  const result = claude.spawn('hello', {
    environment: { model: 'test-model' },
    _spawnImpl: () => {
      spawned.child = fakeChild(script);
      return spawned.child;
    },
    _lockProbe: async () => locked,
    env: { ...process.env, HOME: sessionsTmpDir },
    cwd: sessionsTmpDir,
  }).then((value) => ({ value, child: spawned.child }), (error) => ({ error, child: spawned.child }));
  return result.finally(() => {
    if (saved === undefined) delete process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
    else process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = saved;
  });
};

describe('the claude adapter under the first-output watchdog', () => {
  test('a spawn that never writes is killed with the reason, not left to the run timeout', async () => {
    const { error, child } = await spawnClaude(undefined, { windowMs: 50, locked: true });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(error.code).toBe('spawn_stalled');
    expect(error.message).toBe('claude produced no output in 0s (console locked); killed before the run timeout');
    expect(classifySpawnFailure(error)).toBe(SPAWN_FAILURE_CLASS.STALLED);
  });

  test('a missing transcript alone does not kill: the path may be wrong, so it takes a locked console', async () => {
    const { value, error, child } = await spawnClaude((proc) => {
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('done quietly'));
        proc.emit('close', 0);
      }, 150);
    }, { windowMs: 50, locked: false });
    expect(error).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(value.text).toBe('done quietly');
  });

  test('a descendant still alive when the stalled spawn closes is SIGKILLed', async () => {
    const saved = process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
    process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = '50';
    const kill = jest.fn();
    const started = 'Thu Oct 30 06:59:59 2026';
    try {
      const { error } = await claude.spawn('hello', {
        environment: { model: 'test-model' },
        _spawnImpl: () => {
          const proc = fakeChild();
          proc.pid = 4242;
          // The spawn exits on SIGTERM; its child does not.
          proc.kill = jest.fn((signal) => {
            if (signal === 'SIGTERM') setImmediate(() => proc.emit('close', null));
          });
          return proc;
        },
        _lockProbe: async () => true,
        _stallKillGraceMs: 60_000,
        _processTable: () => [{ pid: 4243, ppid: 4242, started }],
        // By close it has been reparented to launchd.
        _survivorIo: { read: (pid) => (pid === 4243 ? { pid, ppid: 1, started } : null), kill },
        env: { ...process.env, HOME: sessionsTmpDir },
        cwd: sessionsTmpDir,
      }).then(() => ({}), (err) => ({ error: err }));
      expect(error.code).toBe('spawn_stalled');
      expect(kill).toHaveBeenCalledWith(4243, 'SIGKILL');
    } finally {
      if (saved === undefined) delete process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
      else process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = saved;
    }
  });

  test('a stall SIGTERMs the live tree, and a survivor holding the pipe is SIGKILLed when the spawn exits', async () => {
    const saved = process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
    process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = '50';
    const started = 'Thu Oct 30 06:59:59 2026';
    const spawned = {};
    let rootAlive = true;
    // The descendant ignores SIGTERM and holds the inherited stdout, so close
    // fires only once it is SIGKILLed.
    const survivorKill = jest.fn((pid, signal) => {
      if (pid === 4243 && signal === 'SIGKILL') setImmediate(() => spawned.child.emit('close', null));
    });
    const treeKill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const { error } = await claude.spawn('hello', {
        environment: { model: 'test-model' },
        _spawnImpl: () => {
          const proc = fakeChild();
          Object.assign(proc, { pid: 4242, exitCode: null, signalCode: null });
          proc.kill = jest.fn((signal) => {
            if (signal !== 'SIGTERM') return;
            setImmediate(() => {
              rootAlive = false;
              proc.signalCode = 'SIGTERM';
              proc.emit('exit', null, 'SIGTERM');
            });
          });
          spawned.child = proc;
          return proc;
        },
        _lockProbe: async () => true,
        _stallKillGraceMs: 60_000,
        _processTable: () => [{ pid: 4243, ppid: 4242, started }],
        _survivorIo: {
          read: (pid) => (pid === 4243 ? { pid, ppid: rootAlive ? 4242 : 1, started } : null),
          kill: survivorKill,
        },
        env: { ...process.env, HOME: sessionsTmpDir },
        cwd: sessionsTmpDir,
      }).then(() => ({}), (err) => ({ error: err }));
      expect(error.code).toBe('spawn_stalled');
      // The first signal reached the descendant, not only the root.
      expect(treeKill).toHaveBeenCalledWith(4243, 'SIGTERM');
      expect(spawned.child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(survivorKill).toHaveBeenCalledWith(4243, 'SIGKILL');
    } finally {
      treeKill.mockRestore();
      if (saved === undefined) delete process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
      else process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = saved;
    }
  });

  test('a spawn that ignores SIGTERM gets SIGKILL after the grace', async () => {
    const spawned = {};
    const saved = process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
    process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = '50';
    try {
      const { error } = await claude.spawn('hello', {
        environment: { model: 'test-model' },
        _spawnImpl: () => {
          const proc = fakeChild();
          // Parked: SIGTERM does nothing, only SIGKILL ends it.
          proc.kill = jest.fn((signal) => {
            if (signal === 'SIGKILL') setImmediate(() => proc.emit('close', null));
          });
          spawned.child = proc;
          return proc;
        },
        _lockProbe: async () => true,
        _stallKillGraceMs: 30,
        env: { ...process.env, HOME: sessionsTmpDir },
        cwd: sessionsTmpDir,
      }).then(() => ({}), (err) => ({ error: err }));
      expect(spawned.child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(error.code).toBe('spawn_stalled');
    } finally {
      if (saved === undefined) delete process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
      else process.env.COMMONLY_FIRST_OUTPUT_WINDOW_MS = saved;
    }
  });

  test('a slow spawn that is talking is not killed', async () => {
    const { value, error, child } = await spawnClaude((proc) => {
      proc.stderr.emit('data', Buffer.from('warming up'));
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('the answer'));
        proc.emit('close', 0);
      }, 150);
    }, { windowMs: 50 });
    expect(error).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(value.text).toBe('the answer');
  });
});

describe('watchFirstOutput', () => {
  const quietProc = () => ({ stdout: new EventEmitter(), stderr: new EventEmitter() });

  test('a growing transcript counts as started, since claude writes stdout only at the end', async () => {
    const transcript = path.join(sessionsTmpDir, 'session.jsonl');
    fs.writeFileSync(transcript, '{"type":"queue-operation"}\n');
    const onStall = jest.fn();
    let fire;
    watchFirstOutput({
      proc: quietProc(), windowMs: 1000, transcriptPath: transcript, onStall,
      lockProbe: async () => true, setTimeoutImpl: (cb) => { fire = cb; return 0; }, clearTimeoutImpl: () => {},
    });
    fs.appendFileSync(transcript, '{"type":"user"}\n');
    await fire();
    expect(onStall).not.toHaveBeenCalled();
  });

  test('a resumed transcript that does not grow is a stall', async () => {
    const transcript = path.join(sessionsTmpDir, 'resumed.jsonl');
    fs.writeFileSync(transcript, '{"type":"assistant"}\n');
    const onStall = jest.fn();
    let fire;
    watchFirstOutput({
      proc: quietProc(), windowMs: 1000, transcriptPath: transcript, onStall,
      lockProbe: async () => null, setTimeoutImpl: (cb) => { fire = cb; return 0; }, clearTimeoutImpl: () => {},
    });
    await fire();
    expect(onStall).toHaveBeenCalledWith('no transcript, stdout or stderr');
  });

  test('a transcript created empty is not a start', async () => {
    const transcript = path.join(sessionsTmpDir, 'created-empty.jsonl');
    fs.rmSync(transcript, { force: true });
    const onStall = jest.fn();
    let fire;
    watchFirstOutput({
      proc: quietProc(), windowMs: 1000, transcriptPath: transcript, onStall,
      lockProbe: async () => null, setTimeoutImpl: (cb) => { fire = cb; return 0; }, clearTimeoutImpl: () => {},
    });
    fs.writeFileSync(transcript, '');
    await fire();
    expect(onStall).toHaveBeenCalledWith('no transcript, stdout or stderr');
  });

  test('a missing transcript is a stall only on a locked console', async () => {
    const transcript = path.join(sessionsTmpDir, 'never-written.jsonl');
    fs.rmSync(transcript, { force: true });
    for (const [locked, expected] of [[false, 0], [null, 0], [true, 1]]) {
      const onStall = jest.fn();
      let fire;
      watchFirstOutput({
        proc: quietProc(), windowMs: 1000, transcriptPath: transcript, onStall,
        lockProbe: async () => locked, setTimeoutImpl: (cb) => { fire = cb; return 0; }, clearTimeoutImpl: () => {},
      });
      // eslint-disable-next-line no-await-in-loop
      await fire();
      expect(onStall).toHaveBeenCalledTimes(expected);
    }
  });

  test('a descendant that outlived the stalled spawn is SIGKILLed, even reparented; a reused pid is not', () => {
    const snapshot = [
      { pid: 501, ppid: 400, started: 'Thu Oct 30 06:59:59 2026' }, // survived, now under launchd
      { pid: 502, ppid: 400, started: 'Thu Oct 30 06:59:59 2026' }, // exited
      { pid: 503, ppid: 501, started: 'Thu Oct 30 07:00:01 2026' }, // pid reused since
    ];
    const now = {
      501: { pid: 501, ppid: 1, started: 'Thu Oct 30 06:59:59 2026' },
      503: { pid: 503, ppid: 1, started: 'Thu Oct 30 07:05:00 2026' },
    };
    const kill = jest.fn();
    const killed = killStallSurvivors(snapshot, { read: (pid) => now[pid] || null, kill });
    expect(killed).toEqual([501]);
    expect(kill).toHaveBeenCalledWith(501, 'SIGKILL');
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test('the transcript is looked for under the physical cwd', () => {
    const link = path.join(sessionsTmpDir, 'linked-cwd');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(os.tmpdir(), link);
    expect(physicalPath(link)).toBe(fs.realpathSync(os.tmpdir()));
    expect(physicalPath(path.join(sessionsTmpDir, 'absent'))).toBe(path.join(sessionsTmpDir, 'absent'));
  });

  test('a window of 0 turns it off', () => {
    expect(firstOutputWindowMs({ COMMONLY_FIRST_OUTPUT_WINDOW_MS: '0' })).toBe(0);
    expect(firstOutputWindowMs({ COMMONLY_FIRST_OUTPUT_WINDOW_MS: 'soon' })).toBe(DEFAULT_FIRST_OUTPUT_WINDOW_MS);
    expect(firstOutputWindowMs({})).toBe(180_000);
  });
});

describe('consoleLocked', () => {
  const ioreg = (stdout, error = null) => (_cmd, _args, _opts, cb) => cb(error, stdout);

  test('reads IOConsoleLocked from ioreg on darwin', async () => {
    await expect(consoleLocked({ platform: 'darwin', execFileImpl: ioreg('  "IOConsoleLocked" = Yes\n') })).resolves.toBe(true);
    await expect(consoleLocked({ platform: 'darwin', execFileImpl: ioreg('  "IOConsoleLocked" = No\n') })).resolves.toBe(false);
    await expect(consoleLocked({ platform: 'darwin', execFileImpl: ioreg('', new Error('no ioreg')) })).resolves.toBeNull();
    await expect(consoleLocked({ platform: 'linux' })).resolves.toBeNull();
  });
});

describe('the stall backoff', () => {
  test('opens the circuit at once and waits 2, 4, 8, then 15 minutes', () => {
    const error = spawnStalledError({ label: 'claude', windowMs: 180_000, reason: 'console locked' });
    const delays = [1, 2, 3, 4, 5].map((consecutiveFailures) => spawnRetryPolicy({ error, consecutiveFailures }));
    expect(delays.every((retry) => retry.circuitOpen && retry.failureClass === 'stalled')).toBe(true);
    expect(delays.map((retry) => retry.delayMs / 60_000)).toEqual([2, 4, 8, 15, 15]);
  });
});

// ── the run loop ────────────────────────────────────────────────────────────

const drainMicrotasks = async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

describe('performRun — a stalled turn', () => {
  test('releases its claim, backs off with the reason, and resumes when the probe answers', async () => {
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
    const pages = [[{
      _id: 'evt-a',
      type: 'chat.mention',
      podId: 'pod-abc',
      agentName: 'my-stub',
      instanceId: 'default',
      payload: { content: 'are you there?', deliveryId: 'nonce-evt-a', messageId: 'msg-1' },
    }]];
    const acks = [];
    const claimCalls = [];
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events: pages.length ? pages.shift() : [] };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/memory')) return { sections: {} };
      return {};
    });
    const post = jest.fn(async (route, body) => {
      const ack = String(route).match(/\/events\/([^/]+)\/ack$/);
      if (ack) acks.push(ack[1]);
      if (String(route).endsWith('/claim')) {
        claimCalls.push('acquire');
        return { claimed: true };
      }
      if (String(route).endsWith('/events/renew')) {
        return { renewed: body.events.map((entry) => entry.eventId).filter((id) => !acks.includes(id)) };
      }
      return {};
    });
    const del = jest.fn(async (route) => {
      if (String(route).endsWith('/claim')) claimCalls.push('release');
      return {};
    });
    createClient.mockReturnValue({ get, post, del });

    const spawn = jest.fn()
      .mockRejectedValueOnce(spawnStalledError({ label: 'claude', windowMs: 180_000, reason: 'console locked' }))
      .mockResolvedValueOnce({ text: 'yes, back now' });
    const scheduled = [];
    const errors = [];
    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'my-stub',
      retryJitterRatio: 0,
      setTimeoutImpl: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return 0; },
      setIntervalImpl: () => ({}),
      clearIntervalImpl: () => {},
      setDeadlineTimeoutImpl: () => 0,
      clearDeadlineTimeoutImpl: () => {},
      log: () => {},
      onError: (error) => errors.push(error),
    });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      // The stalled turn gave its claim back rather than sitting on it.
      expect(claimCalls).toEqual(['acquire', 'release']);
      expect(acks).toEqual([]);
      const report = errors.find((error) => error.code === 'agent_spawn_retry_scheduled');
      expect(report).toMatchObject({ failureClass: 'stalled', circuitOpen: true, retryAfterMs: 120_000, heldCount: 1 });
      expect(report.message).toContain('console locked');

      // The probe after the backoff talks, so the run resumes and acks.
      const next = scheduled.shift();
      expect(next.delayMs).toBe(120_000);
      next.callback();
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(acks).toEqual(['evt-a']);
    } finally {
      handle.stop?.();
    }
  });
});
