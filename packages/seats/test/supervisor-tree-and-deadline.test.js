// Two layers on top of the group kill, with real processes.
//
// The descendant walk: a CLI's child that moved to a group of its own (codex
// does this for every MCP server and tool command) is outside the group kill,
// so the kill also walks the process tree. A pid is signalled only if its ppid
// and start time still match the snapshot, so a reused pid is left alone.
//
// The SIGTERM deadline: a host that keeps the in-flight turn on SIGTERM keeps
// the groups too, and kills them at a deadline set before launchd's SIGKILL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';
import { runFailure } from '../src/failures.js';
import { observeSpawn } from '../src/runtime-observation.js';
import {
  descendantsOf, killProcessTree, leadsOwnGroup, readProcess, readProcessTable, spawnInOwnGroup, wantsOwnProcessGroup,
} from '../src/process-group.js';
import { isRunning, readPids, reap, waitFor } from '../test-support/processes.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const POSIX = process.platform !== 'win32';

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'seats-tree-'));
  try { return await fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

// A child that starts `count` grandchildren, each the leader of a new group
// (detached), writes their pids, and stays alive.
const NEW_GROUP_PARENT = `
const { spawn } = require('node:child_process');
const pids = [];
for (let i = 0; i < Number(process.argv[2]); i += 1) {
  pids.push(spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }).pid);
}
require('node:fs').writeFileSync(process.argv[1], pids.join(','));
setInterval(() => {}, 1e6);
`;

const startParent = (pidFile, count, ownGroup) => spawnInOwnGroup(
  spawn, process.execPath, ['-e', NEW_GROUP_PARENT, pidFile, String(count)], { stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup },
);

test('the descendant table is read deepest first', () => {
  const table = [
    { pid: 10, ppid: 1, started: 'a' }, { pid: 11, ppid: 10, started: 'b' }, { pid: 12, ppid: 11, started: 'c' },
    { pid: 13, ppid: 10, started: 'd' }, { pid: 20, ppid: 1, started: 'e' },
  ];
  assert.deepEqual(descendantsOf(table, 10).map((row) => [row.pid, row.depth]), [[12, 2], [11, 1], [13, 1]]);
});

test('a stall kill reaches a grandchild that started a group of its own', { skip: !POSIX }, async () => withHome(async (home) => {
  const pidFile = join(home, 'grandchild.pid');
  const children = [];
  let grandchild;
  try {
    const adapter = {
      name: 'new-group-parent',
      spawn: (prompt, ctx) => new Promise((resolve, reject) => {
        const child = startParent(pidFile, 1, wantsOwnProcessGroup(ctx));
        children.push(child);
        observeSpawn(child, ctx.onSpawn, {});
        child.on('close', () => reject(ctx.signal.aborted ? ctx.signal.reason : runFailure('exited', 'parent exited')));
      }),
    };
    const run = superviseRun({
      adapter, prompt: 'p', ctx: {}, store: createTraceStore({ root: join(home, 'trace') }),
      policy: { stallMs: 300, cancelGraceMs: 300, timeoutMs: 20000 },
    });
    [grandchild] = await readPids(pidFile, 1);
    assert.equal(leadsOwnGroup(children[0]), true);
    assert.equal(isRunning(grandchild), true);
    assert.equal((await run).outcome, 'stuck');
    assert.ok(await waitFor(() => !isRunning(grandchild)), `grandchild ${grandchild} in its own group survived the kill`);
  } finally {
    if (grandchild) reap(grandchild);
    for (const child of children) child.kill('SIGKILL');
  }
}));

test('a pid reused by another process is left alone; the descendant the snapshot named is killed', { skip: !POSIX }, async () => withHome(async (home) => {
  const pidFile = join(home, 'grandchildren.pid');
  const parent = startParent(pidFile, 2, true);
  // An unrelated process: not in the parent's tree at all.
  const unrelated = spawn('sleep', ['300'], { stdio: 'ignore' });
  const unrelatedStarted = once(unrelated, 'spawn');
  let real;
  let reused;
  try {
    [real, reused] = await readPids(pidFile, 2);
    await unrelatedStarted;
    const table = readProcessTable();
    assert.ok(table, 'ps is unavailable, so the walk cannot run');
    assert.ok(readProcess(reused), 'the reused stand-in is not running');
    // The snapshot as it would read if each pid had belonged to an earlier
    // process: `reused` is the right parent's child but started at another
    // time, and `unrelated` is named as the parent's child though it is not.
    const stub = table.map((row) => (row.pid === reused ? { ...row, started: 'Thu Jan  1 00:00:00 1970' } : row));
    stub.push({ pid: unrelated.pid, ppid: parent.pid, started: readProcess(unrelated.pid).started });

    killProcessTree(parent, 'SIGKILL', { table: () => stub });

    assert.ok(await waitFor(() => !isRunning(real)), 'the walk did not kill the descendant the snapshot named');
    assert.ok(await waitFor(() => parent.signalCode !== null), 'the parent survived');
    await new Promise((r) => { setTimeout(r, 200); });
    assert.equal(isRunning(reused), true, 'a pid whose start time changed was signalled');
    assert.equal(isRunning(unrelated.pid), true, 'a pid whose parent changed was signalled');
  } finally {
    for (const pid of [real, reused]) if (pid) reap(pid);
    unrelated.kill('SIGKILL');
    parent.kill('SIGKILL');
  }
}));

// ── SIGTERM in a host that keeps the turn ─────────────────────────────────────

// Shaped like `agent run`: SIGTERM asks for a stop after the current turn and
// arms the deadline; when the turn is over, the host's exit path kills the
// groups. The turn ends when the test creates `go`; its child then says
// `done` and lingers, as a CLI shutting down can.
const HOST = ({ pidFile, goFile, deadlineMs }) => `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { superviseRun } from ${JSON.stringify(pathToFileURL(join(SRC, 'supervisor.js')).href)};
import { createTraceStore } from ${JSON.stringify(pathToFileURL(join(SRC, 'trace/store.js')).href)};
import { observeSpawn } from ${JSON.stringify(pathToFileURL(join(SRC, 'runtime-observation.js')).href)};
import {
  armSupervisedGroupDeadline, killSupervisedGroups, spawnInOwnGroup, wantsOwnProcessGroup,
} from ${JSON.stringify(pathToFileURL(join(SRC, 'process-group.js')).href)};
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
  process.stdout.write('stopping\\n');
  armSupervisedGroupDeadline(${deadlineMs});
});
const script = "sleep 300 & echo $! > '${pidFile}'; while [ ! -f '${goFile}' ]; do sleep 0.05; done; echo done; wait";
const adapter = { name: 'sh', spawn: (prompt, ctx) => new Promise((resolve, reject) => {
  const child = spawnInOwnGroup(spawn, 'sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup: wantsOwnProcessGroup(ctx) });
  observeSpawn(child, ctx.onSpawn, {});
  child.stdout.on('data', (chunk) => { if (String(chunk).includes('done')) resolve({ text: 'done' }); });
  child.on('close', (code, signal) => reject(new Error('sh ended ' + (code ?? signal))));
  child.once('spawn', () => {
    const poll = setInterval(() => {
      if (!existsSync('${pidFile}') || !/^\\d+\\s*$/.test(readFileSync('${pidFile}', 'utf8'))) return;
      clearInterval(poll);
      process.stdout.write('ready ' + child.pid + '\\n');
    }, 20);
  });
}) };
const out = await superviseRun({ adapter, prompt: 'p', ctx: {}, store: createTraceStore({ root: ${JSON.stringify(`${pidFile}.trace`)} }),
  policy: { stallMs: 0, timeoutMs: 0 } });
process.stdout.write('turn ' + out.outcome + '\\n');
if (stopping) { killSupervisedGroups(); process.exit(0); }
`;

const startHost = async (home, deadlineMs) => {
  const pidFile = join(home, 'grandchild.pid');
  const goFile = join(home, 'go');
  const script = join(home, 'host.mjs');
  writeFileSync(script, HOST({ pidFile, goFile, deadlineMs }));
  const host = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const state = { host, goFile, out: '' };
  host.stdout.on('data', (chunk) => { state.out += chunk; });
  state.exited = once(host, 'exit');
  assert.ok(await waitFor(() => /ready \d+/.test(state.out)), `host never got ready: ${state.out}`);
  state.leader = Number(state.out.match(/ready (\d+)/)[1]);
  [state.grandchild] = await readPids(pidFile, 1);
  return state;
};

const cleanup = (state) => {
  if (!state) return;
  reap(state.grandchild);
  reap(state.leader);
  state.host.kill('SIGKILL');
};

test('SIGTERM mid-turn: the turn completes, then the groups die', { skip: !POSIX }, async () => withHome(async (home) => {
  let state;
  try {
    state = await startHost(home, 10000);
    state.host.kill('SIGTERM');
    assert.ok(await waitFor(() => /stopping/.test(state.out)), 'the host never saw SIGTERM');
    await new Promise((r) => { setTimeout(r, 400); });
    assert.equal(isRunning(state.grandchild), true, 'SIGTERM killed the turn\'s group');
    assert.equal(isRunning(state.leader), true, 'SIGTERM killed the turn\'s child');
    writeFileSync(state.goFile, '');
    const [code] = await Promise.race([state.exited, new Promise((r) => { setTimeout(() => r(['timeout']), 5000); })]);
    assert.match(state.out, /turn ok/);
    assert.equal(code, 0);
    assert.ok(await waitFor(() => !isRunning(state.grandchild)), 'the group outlived the host');
    assert.ok(await waitFor(() => !isRunning(state.leader)), 'the leader outlived the host');
  } finally {
    cleanup(state);
  }
}));

test('SIGTERM with the turn still running: the deadline kills the groups before ExitTimeOut', { skip: !POSIX }, async () => withHome(async (home) => {
  // Stands in for launchd: ExitTimeOut 2 s, deadline 1 s (the CLI derives the
  // real one from the seat's plist).
  const exitTimeOutMs = 2000;
  const deadlineMs = 1000;
  let state;
  try {
    state = await startHost(home, deadlineMs);
    const sent = Date.now();
    state.host.kill('SIGTERM');
    assert.ok(await waitFor(() => /stopping/.test(state.out)), 'the host never saw SIGTERM');
    await new Promise((r) => { setTimeout(r, deadlineMs / 2); });
    assert.equal(isRunning(state.grandchild), true, 'the group died before its deadline');
    assert.ok(await waitFor(() => !isRunning(state.grandchild), exitTimeOutMs), 'the group outlived ExitTimeOut');
    const diedAfter = Date.now() - sent;
    assert.ok(diedAfter < exitTimeOutMs, `the group died ${diedAfter}ms after SIGTERM, past ExitTimeOut`);
    assert.ok(await waitFor(() => !isRunning(state.leader), 1000), 'the leader outlived its group');
  } finally {
    cleanup(state);
  }
}));
