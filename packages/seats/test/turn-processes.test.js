// A turn's leftovers are what its child started and left running after it
// closed. The real-process tests start a "turn" that detaches node children
// and exits at once, so each one is reparented away from the turn before the
// reap looks, which is the shape of `npm exec vite &` from a shell tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunning, readPids, reap, waitFor } from '../test-support/processes.js';
import {
  describeTurnReap, findTurnProcesses, KEEP_PROCESS_ENV, markTurn, reapTurnProcesses, TURN_MARK_ENV, turnReapEnabled,
} from '../src/turn-processes.js';
import { readProcess, readProcesses } from '../src/process-group.js';

const POSIX = process.platform !== 'win32';
const at = (ms) => new Date(ms).toUTCString();

test('findTurnProcesses takes the marked, their descendants, and nothing kept, old or ours', () => {
  const since = Date.parse('2026-11-01T12:00:00Z');
  const fresh = at(since + 5_000);
  const table = () => [
    { pid: 400, ppid: 1, started: at(since - 60_000) }, // our parent
    { pid: 500, ppid: 400, started: fresh }, // us
    { pid: 600, ppid: 1, started: fresh }, // orphaned leftover
    { pid: 601, ppid: 600, started: fresh }, // its child, environment unreadable
    { pid: 610, ppid: 1, started: fresh }, // kept
    { pid: 611, ppid: 610, started: fresh }, // kept by inheritance
    { pid: 620, ppid: 1, started: fresh }, // another seat's process
    { pid: 630, ppid: 1, started: at(since - 30_000) }, // carries the mark, started before the turn
  ];
  const mark = 'm-1';
  const pair = `${TURN_MARK_ENV}=${mark}`;
  const keep = `${KEEP_PROCESS_ENV}=1`;
  const environments = new Map([
    [500, new Set([pair])],
    [600, new Set(['node', pair])],
    [601, new Set(['sh'])],
    [610, new Set([pair, keep])],
    [611, new Set([pair, keep])],
    [620, new Set([`${TURN_MARK_ENV}=other`])],
    [630, new Set([pair])],
  ]);
  const asked = [];
  const envs = (pids) => { asked.push(...pids); return environments; };

  const found = findTurnProcesses(mark, since, { table, envs, self: 500 });

  assert.deepEqual(found.map((row) => row.pid).sort(), [600, 601]);
  // Only processes started since the turn began are read, never us or our parent.
  assert.deepEqual(asked.sort(), [600, 601, 610, 611, 620]);
  assert.deepEqual(findTurnProcesses(null, since, { table, envs, self: 500 }), []);
});

test('a kept process keeps everything under it, even a child whose environment cannot be read', () => {
  const since = Date.parse('2026-11-01T12:00:00Z');
  const fresh = at(since + 5_000);
  // A marked shell runs `COMMONLY_KEEP_PROCESS=1 npm run dev`: npm -> sh -c vite -> vite.
  const table = () => [
    { pid: 700, ppid: 1, started: fresh }, // the marked shell
    { pid: 701, ppid: 700, started: fresh }, // npm, kept
    { pid: 702, ppid: 701, started: fresh }, // sh, environment unreadable
    { pid: 703, ppid: 702, started: fresh }, // vite, kept by inheritance
    { pid: 704, ppid: 700, started: fresh }, // the shell's other child, environment unreadable
  ];
  const pair = `${TURN_MARK_ENV}=m-2`;
  const keep = `${KEEP_PROCESS_ENV}=1`;
  const envs = () => new Map([
    [700, new Set([pair])],
    [701, new Set([pair, keep])],
    [702, new Set(['sh'])],
    [703, new Set([pair, keep])],
    [704, new Set(['sleep'])],
  ]);

  const found = findTurnProcesses('m-2', since, { table, envs, self: 500 });

  assert.deepEqual(found.map((row) => row.pid).sort(), [700, 704]);
});

test('the check is on unless COMMONLY_TURN_REAP=0, and a child with no pid is never reaped', () => {
  assert.equal(turnReapEnabled({}), POSIX);
  assert.equal(turnReapEnabled({ COMMONLY_TURN_REAP: '0' }), false);
  const off = markTurn({ A: '1' }, { enabled: false });
  assert.deepEqual(off.env, { A: '1' });
  assert.equal(off.reap({ pid: 123 }), null);
  const on = markTurn({ A: '1' }, { enabled: true });
  assert.equal(on.env[TURN_MARK_ENV], on.mark);
  assert.equal(on.env.A, '1');
  assert.equal(on.reap({}), null);
  // A keep setting the seat was started with is not handed to its turns.
  const seatKept = markTurn({ A: '1', [KEEP_PROCESS_ENV]: '1' }, { enabled: true });
  assert.equal(seatKept.env[KEEP_PROCESS_ENV], undefined);
  assert.equal(seatKept.env.A, '1');
  assert.equal(describeTurnReap({ termed: [] }), null);
  assert.match(describeTurnReap({ termed: [7, 8] }), /stopped 2 processes .*pid 7, 8.*COMMONLY_KEEP_PROCESS=1/);
});

// The turn writes "<leftover>,<kept>,<stubborn>" and exits.
const TURN = `
const { spawn } = require('child_process');
const start = (env, script) => {
  const c = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env });
  c.unref();
  return c.pid;
};
const idle = 'setInterval(() => {}, 1000);';
const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const pids = [
  start(process.env, idle),
  start({ ...process.env, ${KEEP_PROCESS_ENV}: '1' }, idle),
  start(process.env, stubborn),
];
require('fs').writeFileSync(process.argv[1], pids.join(','));
`;

test('a turn that detaches children leaves none running, except the one it kept', { skip: !POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-processes-'));
  const pidFile = join(dir, 'pids');
  const turn = markTurn({ ...process.env }, { enabled: true, graceMs: 500 });
  // Started in the turn's window, without the mark: another seat's process.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  let pids = [];
  try {
    const child = spawn(process.execPath, ['-e', TURN, pidFile], { env: turn.env, stdio: 'ignore' });
    await once(child, 'close');
    pids = await readPids(pidFile, 3);
    const [leftover, kept, stubborn] = pids;
    // Each one is up before the reap looks.
    assert.ok(await waitFor(() => pids.every((pid) => readProcess(pid))));

    const result = turn.reap(child);

    assert.deepEqual([...result.termed].sort(), [leftover, stubborn].sort());
    assert.ok(await waitFor(() => !isRunning(leftover)), 'the leftover is gone');
    // One that ignores SIGTERM gets SIGKILL at the grace.
    assert.ok(isRunning(stubborn));
    assert.deepEqual((await result.done).killed, [stubborn]);
    assert.ok(await waitFor(() => !isRunning(stubborn)), 'the stubborn one is gone');
    assert.ok(isRunning(kept), 'the kept one runs on');
    assert.ok(isRunning(bystander.pid), 'an unmarked process is untouched');
  } finally {
    for (const pid of [...pids, bystander.pid]) reap(pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pid whose start time changed since it was found is not signalled', { skip: !POSIX }, async () => {
  const turn = markTurn({ ...process.env }, { enabled: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { env: turn.env, stdio: 'ignore' });
  try {
    assert.ok(await waitFor(() => readProcess(child.pid)));
    const result = reapTurnProcesses(turn.mark, Date.now() - 2_000, {
      io: { read: (pids) => readProcesses(pids).map((row) => ({ ...row, started: 'Thu Jan  1 00:00:00 1970' })) },
    });
    assert.deepEqual(result.termed, []);
    assert.ok(isRunning(child.pid));
  } finally {
    reap(child.pid);
  }
});
