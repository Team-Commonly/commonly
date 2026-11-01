// A turn's leftovers are what its child started and left running after it
// closed. The real-process tests start a "turn" that detaches node children
// and exits at once, so each one is reparented away from the turn before the
// reap looks, which is the shape of `npm exec vite &` from a shell tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunning, readPids, reap, waitFor } from '../test-support/processes.js';
import {
  describeTurnReap, findTurnProcesses, KEEP_PROCESS_ENV, markTurn, reapTurnProcesses, TURN_MARK_ENV,
  TURN_START_SLACK_MS, turnReapEnabled,
} from '../src/turn-processes.js';
import { readProcess, readProcesses, startedMs } from '../src/process-group.js';

const POSIX = process.platform !== 'win32';
// A start time as ps prints it: `Sun Nov  1 12:00:00 2026`, in UTC.
const at = (ms) => {
  const [day, date, month, year, time] = new Date(ms).toUTCString().split(' ');
  return `${day.slice(0, 3)} ${month} ${String(Number(date)).padStart(2)} ${time} ${year}`;
};
const inZone = (tz, fn) => {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
};

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
    { pid: 630, ppid: 1, started: at(since - TURN_START_SLACK_MS - 1_000) }, // carries the mark, started before the window
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

test('a leftover whose recorded start reads a few seconds early is still found', () => {
  // Linux ps derives lstart from the boot time, which drifts from the wall
  // clock: a process started during the turn can read as started before it.
  const since = Date.parse('2026-11-01T12:00:00Z');
  const table = () => [
    { pid: 800, ppid: 1, started: at(since - 3_000) }, // drifted, carries the mark
    { pid: 801, ppid: 1, started: at(since - TURN_START_SLACK_MS - 1_000) }, // outside the window
  ];
  const pair = `${TURN_MARK_ENV}=m-3`;
  const asked = [];
  const envs = (pids) => { asked.push(...pids); return new Map(pids.map((pid) => [pid, new Set([pair])])); };

  const found = findTurnProcesses('m-3', since, { table, envs, self: 500 });

  assert.deepEqual(found.map((row) => row.pid), [800]);
  assert.deepEqual(asked, [800]);
});

test('a start time in the hour daylight saving repeats reads as the hour it was', () => {
  // 01:30 comes twice in Los Angeles on 2026-11-01: at 08:30 and at 09:30 UTC.
  inZone('America/Los_Angeles', () => {
    assert.equal(startedMs(at(Date.parse('2026-11-01T08:30:00Z'))), Date.parse('2026-11-01T08:30:00Z'));
    assert.equal(startedMs(at(Date.parse('2026-11-01T09:30:00Z'))), Date.parse('2026-11-01T09:30:00Z'));
  });
});

test('ps prints start times in UTC whatever zone the seat runs in', { skip: !POSIX }, () => {
  const self = readProcess(process.pid);
  const began = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(startedMs(self.started) - began) < 5_000, `${self.started} is not when this process began`);
});

test('a leftover is found in a seat running east of UTC', () => {
  // Read as local time, 12:00:05 UTC would be 06:30:05 UTC here, before the turn.
  const since = Date.parse('2026-11-01T12:00:00Z');
  const table = () => [{ pid: 900, ppid: 1, started: at(since + 5_000) }];
  const pair = `${TURN_MARK_ENV}=m-4`;
  const envs = (pids) => new Map(pids.map((pid) => [pid, new Set([pair])]));

  const found = inZone('Asia/Kolkata', () => findTurnProcesses('m-4', since, { table, envs, self: 500 }));

  assert.deepEqual(found.map((row) => row.pid), [900]);
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
  // A turn is reaped once, however often its child reports closing.
  let reads = 0;
  const io = { table: () => { reads += 1; return []; }, envs: () => new Map() };
  assert.deepEqual(on.reap({ pid: 123 }, { io }).termed, []);
  assert.equal(on.reap({ pid: 123 }, { io }), null);
  assert.equal(reads, 1);
  // A keep setting the seat was started with is not handed to its turns.
  const seatKept = markTurn({ A: '1', [KEEP_PROCESS_ENV]: '1' }, { enabled: true });
  assert.equal(seatKept.env[KEEP_PROCESS_ENV], undefined);
  assert.equal(seatKept.env.A, '1');
  assert.equal(describeTurnReap({ termed: [] }), null);
  assert.match(describeTurnReap({ termed: [7, 8] }), /stopped 2 processes .*pid 7, 8.*COMMONLY_KEEP_PROCESS=1/);
});

// The turn writes "<leftover>,<kept>,<stubborn>" and exits. The stubborn one
// writes the ready file once its SIGTERM handler is in, so no SIGTERM can beat it.
const TURN = `
const { spawn } = require('child_process');
const start = (env, script) => {
  const c = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env });
  c.unref();
  return c.pid;
};
const idle = 'setInterval(() => {}, 1000);';
const stubborn = "process.on('SIGTERM', () => {}); "
  + "require('fs').writeFileSync(process.env.TURN_READY_FILE, '1'); setInterval(() => {}, 1000);";
const pids = [
  start(process.env, idle),
  start({ ...process.env, ${KEEP_PROCESS_ENV}: '1' }, idle),
  start({ ...process.env, TURN_READY_FILE: process.argv[2] }, stubborn),
];
require('fs').writeFileSync(process.argv[1], pids.join(','));
`;

test('a turn that detaches children leaves none running, except the one it kept', { skip: !POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-processes-'));
  const pidFile = join(dir, 'pids');
  const readyFile = join(dir, 'ready');
  const turn = markTurn({ ...process.env }, { enabled: true, graceMs: 500 });
  // Started in the turn's window, without the mark: another seat's process.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  let pids = [];
  try {
    const child = spawn(process.execPath, ['-e', TURN, pidFile, readyFile], { env: turn.env, stdio: 'ignore' });
    await once(child, 'close');
    pids = await readPids(pidFile, 3);
    const [leftover, kept, stubborn] = pids;
    // Each one is up before the reap looks, and the stubborn one is ignoring SIGTERM.
    assert.ok(await waitFor(() => pids.every((pid) => readProcess(pid))));
    assert.ok(await waitFor(() => existsSync(readyFile)), 'the stubborn one has its handler in');

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
