// A stalled turn's kill has to reach what the agent CLI spawned, not only the
// CLI. Each test here uses real processes: a shell that starts a grandchild
// (`sleep 300 &`), writes its pid, and waits on it, which is the shape of a CLI
// that started an MCP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';
import { runFailure } from '../src/failures.js';
import { observeSpawn } from '../src/runtime-observation.js';
import {
  LEADS_PROCESS_GROUP, OWN_PROCESS_GROUP, leadsOwnGroup, spawnInOwnGroup, trackedGroupCount, wantsOwnProcessGroup,
} from '../src/process-group.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const POSIX = process.platform !== 'win32';
const STDIO = ['ignore', 'pipe', 'pipe'];

// A zombie still answers kill(pid, 0); on Linux it is read as gone, because a
// SIGKILLed orphan waits there until init reaps it.
const isRunning = (pid) => {
  try { process.kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};

const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return predicate();
};

const readPid = async (file) => {
  assert.ok(await waitFor(() => existsSync(file) && /^\d+\s*$/.test(readFileSync(file, 'utf8'))), `no pid in ${file}`);
  return Number(readFileSync(file, 'utf8'));
};

const reap = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

/**
 * An adapter shaped like the real ones: it spawns through spawnInOwnGroup,
 * asking for a group only when the supervisor offered one, and reports the
 * child through onSpawn. It ignores the abort, so the supervisor's kill is the
 * only thing that ends the turn.
 */
const grandchildAdapter = ({ pidFile, children, honourGroup = true }) => ({
  name: 'sh-grandchild',
  spawn(prompt, ctx) {
    return new Promise((resolve, reject) => {
      const child = spawnInOwnGroup(spawn, 'sh', ['-c', `sleep 300 & echo $! > '${pidFile}'; wait`], { stdio: STDIO }, {
        ownGroup: honourGroup && wantsOwnProcessGroup(ctx),
      });
      children.push(child);
      observeSpawn(child, ctx.onSpawn, {});
      child.on('close', (code, signal) => {
        if (ctx.signal.aborted) reject(ctx.signal.reason);
        else reject(runFailure('exited', `sh exited ${code ?? signal}`));
      });
    });
  },
});

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'seats-group-kill-'));
  try { return await fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

const STALL = { stallMs: 300, cancelGraceMs: 300, timeoutMs: 20000 };

test('the supervisor tells the adapter it may lead its own group', async () => withHome(async (home) => {
  let seen;
  const adapter = { name: 'spy', spawn: async (prompt, ctx) => { seen = ctx; return { text: 'ok' }; } };
  await superviseRun({ adapter, prompt: 'p', ctx: {}, store: createTraceStore({ root: join(home, 'trace') }) });
  assert.equal(seen[OWN_PROCESS_GROUP], true);
}));

test('unasked, spawnInOwnGroup hands the options through untouched', () => {
  const options = { cwd: '/x', env: { A: '1' }, stdio: STDIO };
  const calls = [];
  const child = spawnInOwnGroup((...args) => { calls.push(args); return {}; }, 'cmd', ['a'], options);
  assert.equal(calls[0][2], options);
  assert.equal(Object.hasOwn(calls[0][2], 'detached'), false);
  assert.equal(child[LEADS_PROCESS_GROUP], undefined);
});

test('a group-leading child is never inferred: detached without the marker is not a leader', { skip: !POSIX }, async () => {
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.equal(leadsOwnGroup(child), false);
    child[LEADS_PROCESS_GROUP] = true;
    assert.equal(leadsOwnGroup(child), true);
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  assert.equal(leadsOwnGroup(child), false, 'a reaped child leads nothing, marked or not');
});

test('a stalled turn\'s kill reaches the grandchild of a group-leading child', { skip: !POSIX }, async () => withHome(async (home) => {
  const pidFile = join(home, 'grandchild.pid');
  const children = [];
  let grandchild;
  try {
    const run = superviseRun({
      adapter: grandchildAdapter({ pidFile, children }), prompt: 'p', ctx: {},
      store: createTraceStore({ root: join(home, 'trace') }), policy: STALL,
    });
    grandchild = await readPid(pidFile);
    assert.equal(leadsOwnGroup(children[0]), true);
    assert.equal(isRunning(grandchild), true);
    const out = await run;
    assert.equal(out.outcome, 'stuck');
    assert.ok(await waitFor(() => !isRunning(grandchild)), `grandchild ${grandchild} survived the kill`);
    assert.ok(await waitFor(() => children[0].exitCode !== null || children[0].signalCode !== null), 'the leader survived');
    assert.ok(await waitFor(() => trackedGroupCount() === 0), 'the exited group is still tracked');
  } finally {
    if (grandchild) reap(grandchild);
    for (const child of children) child.kill('SIGKILL');
  }
}));

test('a child that does not lead its group is killed with child.kill, and no negative pid is signalled', { skip: !POSIX }, async (t) => withHome(async (home) => {
  const pidFile = join(home, 'grandchild.pid');
  const children = [];
  const groupSignals = [];
  const realKill = process.kill;
  t.mock.method(process, 'kill', function kill(pid, signal) {
    if (Number(pid) < 0) groupSignals.push([pid, signal]);
    return realKill.call(process, pid, signal);
  });
  let grandchild;
  try {
    const out = await (async () => {
      const run = superviseRun({
        adapter: grandchildAdapter({ pidFile, children, honourGroup: false }), prompt: 'p', ctx: {},
        store: createTraceStore({ root: join(home, 'trace') }), policy: STALL,
      });
      grandchild = await readPid(pidFile);
      return run;
    })();
    assert.equal(out.outcome, 'stuck');
    assert.equal(leadsOwnGroup(children[0]), false);
    assert.ok(await waitFor(() => children[0].signalCode !== null), 'child.kill did not reach the child');
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.deepEqual(groupSignals, []);
  } finally {
    if (grandchild) reap(grandchild);
    for (const child of children) child.kill('SIGKILL');
  }
}));

// ── The wrapper's own exit ──────────────────────────────────────────────────
// A group-leading child is outside the wrapper's group, so launchd's kill of
// the seat's group no longer reaches it. The wrapper itself has to kill it.

const WRAPPER = (pidFile, mode) => `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { superviseRun } from ${JSON.stringify(pathToFileURL(join(SRC, 'supervisor.js')).href)};
import { createTraceStore } from ${JSON.stringify(pathToFileURL(join(SRC, 'trace/store.js')).href)};
import { observeSpawn } from ${JSON.stringify(pathToFileURL(join(SRC, 'runtime-observation.js')).href)};
import { spawnInOwnGroup, wantsOwnProcessGroup } from ${JSON.stringify(pathToFileURL(join(SRC, 'process-group.js')).href)};
const mode = ${JSON.stringify(mode)};
if (mode === 'host-handler') {
  // Like 'agent run': the host handles the signal and decides when to exit.
  process.on('SIGINT', () => { process.stdout.write('host-handled\\n'); setTimeout(() => process.exit(7), 300); });
}
const adapter = { name: 'sh', spawn: (prompt, ctx) => new Promise(() => {
  const child = spawnInOwnGroup(spawn, 'sh', ['-c', "sleep 300 & echo $! > '${pidFile}'; wait"], { stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup: wantsOwnProcessGroup(ctx) });
  observeSpawn(child, ctx.onSpawn, {});
  child.once('spawn', () => {
    const poll = setInterval(() => {
      if (!existsSync('${pidFile}') || !/^\\d+\\s*$/.test(readFileSync('${pidFile}', 'utf8'))) return;
      clearInterval(poll);
      process.stdout.write('ready ' + child.pid + '\\n');
      if (mode === 'exit') process.exit(3);
    }, 20);
  });
}) };
superviseRun({ adapter, prompt: 'p', ctx: {}, store: createTraceStore({ root: ${JSON.stringify(`${pidFile}.trace`)} }),
  policy: { stallMs: 0, timeoutMs: 0 } });
`;

const runWrapper = async (home, mode, signal) => {
  const pidFile = join(home, `grandchild-${mode}-${signal || 'none'}.pid`);
  const script = join(home, `wrapper-${mode}-${signal || 'none'}.mjs`);
  writeFileSync(script, WRAPPER(pidFile, mode));
  const wrapper = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  wrapper.stdout.on('data', (chunk) => { out += chunk; });
  const exited = once(wrapper, 'exit');
  let leader;
  let grandchild;
  try {
    assert.ok(await waitFor(() => /ready \d+/.test(out)), `wrapper never got ready: ${out}`);
    leader = Number(out.match(/ready (\d+)/)[1]);
    grandchild = await readPid(pidFile);
    if (signal) {
      assert.equal(isRunning(grandchild), true);
      wrapper.kill(signal);
    }
    const [code, how] = await Promise.race([exited, new Promise((r) => { setTimeout(() => r([null, 'timeout']), 5000); })]);
    assert.ok(await waitFor(() => !isRunning(grandchild)), `grandchild ${grandchild} survived the wrapper (${mode}, ${signal})`);
    assert.ok(await waitFor(() => !isRunning(leader)), `leader ${leader} survived the wrapper (${mode}, ${signal})`);
    return { code, how, out };
  } finally {
    if (grandchild) reap(grandchild);
    if (leader) reap(leader);
    wrapper.kill('SIGKILL');
  }
};

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`a wrapper killed by ${signal} takes its supervised groups with it, and still dies by ${signal}`, { skip: !POSIX }, async () => withHome(async (home) => {
    const { code, how } = await runWrapper(home, 'plain', signal);
    assert.equal(code, null);
    assert.equal(how, signal, 'the wrapper no longer dies by the signal it was sent');
  }));
}

test('a wrapper that exits takes its supervised groups with it', { skip: !POSIX }, async () => withHome(async (home) => {
  const { code } = await runWrapper(home, 'exit', null);
  assert.equal(code, 3);
}));

test('a wrapper that handles the signal itself still loses its groups, and exits on its own terms', { skip: !POSIX }, async () => withHome(async (home) => {
  const { code, out } = await runWrapper(home, 'host-handler', 'SIGINT');
  assert.match(out, /host-handled/);
  assert.equal(code, 7);
}));
