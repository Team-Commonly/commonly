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
      pids = await runTurn(adapter, { _turnReap: false });

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
