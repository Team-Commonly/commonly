/**
 * F257: an OpenCode turn that times out is killed as a tree, and a turn that
 * ends on a signal says which one. Before, the timeout signalled only the
 * spawned process, so a child of it (a launcher's real binary, an MCP server)
 * that ignored SIGTERM kept the turn's stdout open and close never fired; and
 * a signal exit with no stderr was reported as just "opencode".
 */
import { spawn as childSpawn } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import opencode from '../src/lib/adapters/opencode.js';

let root;
let started = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-f257-'));
  started = [];
});
// A failing run would leave these alive, ignoring SIGTERM, so kill them here.
afterEach(async () => {
  for (const file of ['grandchild.pid']) {
    const pid = Number(await readFile(join(root, file), 'utf8').catch(() => ''));
    if (pid) started.push(pid);
  }
  for (const pid of started) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  await rm(root, { recursive: true, force: true });
});

const contextWith = (spawnImpl, extra = {}) => ({
  sessionId: null,
  cwd: root,
  env: { ...process.env, XDG_DATA_HOME: join(root, 'data') },
  environment: { model: 'anthropic/claude-sonnet-4-5' },
  agentName: 'f257-seat',
  _binaryPath: '/usr/local/bin/opencode',
  _spawnImpl: spawnImpl,
  ...extra,
});

// A launcher that starts a grandchild ignoring SIGTERM. `holdOutput`: the
// grandchild shares the turn's stdout. `launcherIgnoresTerm`: the launcher
// stays up through SIGTERM, so it is still the grandchild's parent at SIGKILL.
const writeLauncher = async ({ holdOutput, launcherIgnoresTerm }) => {
  const pidFile = join(root, 'grandchild.pid');
  const launcher = join(root, 'launcher.cjs');
  await writeFile(launcher, [
    ...(launcherIgnoresTerm ? ["for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => {});"] : []),
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"],",
    `  { stdio: ${holdOutput ? "['ignore', 'inherit', 'inherit']" : "'ignore'"} });`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const spawnImpl = (cmd, args, options) => {
    const proc = childSpawn(process.execPath, [launcher], options);
    started.push(proc.pid);
    return proc;
  };
  return { pidFile, spawnImpl };
};

const deadWithin = async (pid, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return !isAlive(pid);
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a turn that ends on a signal names the signal', async () => {
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setTimeout(() => proc.emit('close', null, 'SIGKILL'), 0);
    return proc;
  };
  await expect(opencode.spawn('hi', contextWith(spawnImpl))).rejects.toThrow(/^opencode ended on SIGKILL$/);
});

test('a timed-out turn kills a child that ignores SIGTERM and holds the output open', async () => {
  const { pidFile, spawnImpl } = await writeLauncher({ holdOutput: true, launcherIgnoresTerm: true });
  const begun = Date.now();
  await expect(opencode.spawn('hi', contextWith(spawnImpl, { timeoutMs: 1500, _terminationGraceMs: 300 })))
    .rejects.toThrow(/opencode timed out after 1500ms/);
  expect(Date.now() - begun).toBeLessThan(6000);
  expect(await deadWithin(Number(await readFile(pidFile, 'utf8')), 2000)).toBe(true);
}, 15000);

// The launcher exits on SIGTERM, so the grandchild is reparented and a tree
// walk from the launcher can't find it at SIGKILL. The SIGTERM-time snapshot can.
test('a timed-out turn kills a child left behind when its parent exits on SIGTERM', async () => {
  const { pidFile, spawnImpl } = await writeLauncher({ holdOutput: false, launcherIgnoresTerm: false });
  await expect(opencode.spawn('hi', contextWith(spawnImpl, { timeoutMs: 1500, _terminationGraceMs: 300 })))
    .rejects.toThrow(/opencode timed out after 1500ms/);
  expect(await deadWithin(Number(await readFile(pidFile, 'utf8')), 2000)).toBe(true);
}, 15000);
