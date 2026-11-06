/**
 * turn-leftovers.test.mjs — a turn leaves nothing running when it ends.
 *
 * Seen 2026-11-01: seat turns backgrounded dev servers (`npm exec vite &`),
 * which were orphaned to launchd when the turn's shell exited. Six such trees,
 * one to four days old, took the fleet host's swap to 12 GB. Each test here
 * runs a real turn that detaches children and exits at once, then checks what
 * is still running after the adapter returns.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn as realSpawn } from 'child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-turn-leftovers-'));
await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => home },
  homedir: () => home,
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;
const codex = (await import('../src/lib/adapters/codex.js')).default;
const { KEEP_PROCESS_ENV, TURN_MARK_ENV } = await import('@commonlyai/seats/turn-processes');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const POSIX = process.platform !== 'win32';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return predicate();
};

// The turn starts a leftover and a kept process, both detached, writes their
// pids, prints a reply and exits.
const TURN = `
const { spawn } = require('child_process');
const start = (env) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, stdio: 'ignore', env });
  c.unref();
  return c.pid;
};
const pids = [start(process.env), start({ ...process.env, ${KEEP_PROCESS_ENV}: '1' })];
require('fs').writeFileSync(process.argv[1], pids.join(','));
process.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`;

const runTurn = async (adapter, extra = {}) => {
  const pidFile = path.join(home, `pids-${adapter.name}-${Date.now()}`);
  let markedEnv = null;
  await adapter.spawn('hello', {
    environment: { model: 'test-model' },
    sessionId: null,
    _spawnImpl: (_cmd, _args, options) => {
      markedEnv = options.env;
      return realSpawn(process.execPath, ['-e', TURN, pidFile], { ...options, cwd: home });
    },
    _lockProbe: async () => false,
    env: { ...process.env, HOME: home },
    cwd: home,
    ...extra,
  });
  const [leftover, kept] = fs.readFileSync(pidFile, 'utf8').trim().split(',').map(Number);
  return { leftover, kept, markedEnv };
};

describe.each([['claude', claude], ['codex', codex]])('%s: what a turn leaves running', (name, adapter) => {
  (POSIX ? test : test.skip)('is stopped when the turn ends, except a process started with COMMONLY_KEEP_PROCESS=1', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let pids = {};
    try {
      pids = await runTurn(adapter);

      expect(pids.markedEnv[TURN_MARK_ENV]).toEqual(expect.any(String));
      expect(await waitFor(() => !alive(pids.leftover))).toBe(true);
      expect(alive(pids.kept)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(
        new RegExp(`^\\[${name}\\] stopped 1 process this turn left running \\(pid ${pids.leftover}\\)`),
      ));
    } finally {
      warn.mockRestore();
      for (const pid of [pids.leftover, pids.kept]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }, 20_000);

  (POSIX ? test : test.skip)('runs on when the check is off', async () => {
    let pids = {};
    try {
      // Without the marker of any turn this suite itself runs in.
      const { [TURN_MARK_ENV]: _outerMark, ...outside } = process.env;
      pids = await runTurn(adapter, { _turnReap: false, env: { ...outside, HOME: home } });

      expect(pids.markedEnv[TURN_MARK_ENV]).toBeUndefined();
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(alive(pids.leftover)).toBe(true);
    } finally {
      for (const pid of [pids.leftover, pids.kept]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }, 20_000);
});

// A public seat's turn is confined, and keeps nothing it leaves running: the
// keep setting is not honoured there, and the log says so once (F197). These
// run the claude adapter's Seatbelt path with a real child, intercepted before
// sandbox-exec, so they need macOS.
const DARWIN = process.platform === 'darwin';
describe('claude: what a confined turn leaves running', () => {
  const confined = (trust) => ({
    environment: { model: 'test-model', sandbox: { mode: 'workspace', trust } },
    agentName: `f197-${trust}`,
    skillMountDir: home,
    // Outside the workspace (home): a workspace seat's folder may not contain
    // the record of its realpath kept beside the state folder (F200).
    _publicClaudeState: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-turn-leftovers-state-')), `state-${trust}`),
    _startProviderProxy: async () => ({
      baseURL: 'http://127.0.0.1:41597/', token: 'per-turn-f197', port: 41597, close: async () => {},
    }),
    env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-f197-host-only' },
  });

  (DARWIN ? test : test.skip)('a public seat stops the process set to keep too, and logs that the setting was not honoured', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let pids = {};
    try {
      pids = await runTurn(claude, confined('public'));

      expect(await waitFor(() => !alive(pids.leftover))).toBe(true);
      expect(await waitFor(() => !alive(pids.kept))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(
        `^\\[claude\\] stopped 2 processes this turn left running .*${KEEP_PROCESS_ENV}=1 was set on pid ${pids.kept} `
        + 'and is not honoured on a confined seat$',
      )));
    } finally {
      warn.mockRestore();
      for (const pid of [pids.leftover, pids.kept]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }, 20_000);

  (DARWIN ? test : test.skip)('a workspace seat still keeps the process set to keep', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let pids = {};
    try {
      pids = await runTurn(claude, confined('workspace'));

      expect(await waitFor(() => !alive(pids.leftover))).toBe(true);
      expect(alive(pids.kept)).toBe(true);
    } finally {
      warn.mockRestore();
      for (const pid of [pids.leftover, pids.kept]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }, 20_000);
});

// The codex adapter's public seat is confined too (F201): it keeps nothing a
// turn leaves running, as the claude adapter's public seat does. A private
// codex seat still keeps a process started with the setting.
describe('codex: what a public seat\'s turn leaves running', () => {
  const seat = (trust) => {
    const { OPENAI_BASE_URL: _route, ...outside } = process.env;
    return {
      environment: { model: 'test-model', ...(trust ? { sandbox: { mode: 'workspace', trust } } : {}) },
      agentName: `f201-${trust || 'private'}`,
      _homeDir: home,
      _codexVersion: '0.162.1',
      _publicCodexHome: path.join(home, `codex-home-${trust || 'private'}-${Date.now()}`),
      env: { ...outside, HOME: home, CODEX_HOME: path.join(home, 'operator-codex') },
    };
  };

  (POSIX ? test : test.skip)('a public seat stops the process set to keep too, and logs that the setting was not honoured', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let pids = {};
    try {
      pids = await runTurn(codex, seat('public'));

      expect(await waitFor(() => !alive(pids.leftover))).toBe(true);
      expect(await waitFor(() => !alive(pids.kept))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(
        `^\\[codex\\] stopped 2 processes this turn left running .*${KEEP_PROCESS_ENV}=1 was set on pid ${pids.kept} `
        + 'and is not honoured on a confined seat$',
      )));
    } finally {
      warn.mockRestore();
      for (const pid of [pids.leftover, pids.kept]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }, 20_000);

  (POSIX ? test : test.skip)('a private seat still keeps the process set to keep', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let pids = {};
    try {
      pids = await runTurn(codex, seat(null));

      expect(await waitFor(() => !alive(pids.leftover))).toBe(true);
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(alive(pids.kept)).toBe(true);
    } finally {
      warn.mockRestore();
      for (const pid of [pids.leftover, pids.kept]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }, 20_000);
});
