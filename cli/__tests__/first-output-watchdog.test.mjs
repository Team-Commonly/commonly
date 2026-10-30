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
  consoleLocked, spawnStalledError, watchFirstOutput, firstOutputWindowMs, DEFAULT_FIRST_OUTPUT_WINDOW_MS,
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

  test('an unlocked console names the missing output instead', async () => {
    const { error } = await spawnClaude(undefined, { windowMs: 50, locked: false });
    expect(error.stallReason).toBe('no transcript, stdout or stderr');
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
