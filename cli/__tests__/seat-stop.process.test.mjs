/**
 * seat-stop with real processes, wired the way `agent run` wires it: SIGTERM
 * calls requestStop, and the exit path calls onExit. The supervised child
 * leads its own group and holds a grandchild (`sleep 300 &`), the shape of a
 * CLI holding an MCP server.
 *
 * - A launchd seat (its plist exists): the groups die a margin before
 *   ExitTimeOut, while the turn is still running.
 * - A daemon-spawned seat (no plist): nothing is armed, the turn runs past the
 *   15 s a default deadline would have cut it at, and the groups die on exit.
 */
import { spawn } from 'child_process';
import { once } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAT_STOP = pathToFileURL(join(HERE, '..', 'src', 'lib', 'seat-stop.js')).href;
const SEATS = join(HERE, '..', '..', 'packages', 'seats', 'src');
const seats = (file) => JSON.stringify(pathToFileURL(join(SEATS, file)).href);
const POSIX = process.platform !== 'win32';

const isRunning = (pid) => {
  try { process.kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
};
const reap = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

const HOST = ({ home, pidFile, goFile }) => `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createSeatStop } from ${JSON.stringify(SEAT_STOP)};
import { superviseRun } from ${seats('supervisor.js')};
import { createTraceStore } from ${seats('trace/store.js')};
import { observeSpawn } from ${seats('runtime-observation.js')};
import { spawnInOwnGroup, wantsOwnProcessGroup } from ${seats('process-group.js')};
let stopping = false;
const seatStop = createSeatStop({ name: 'probe', stop: () => { stopping = true; }, home: ${JSON.stringify(home)} });
process.on('SIGTERM', (signal) => { process.stdout.write('stopping deadline=' + seatStop.requestStop(signal) + '\\n'); });
process.once('exit', seatStop.onExit);
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
const out = await superviseRun({ adapter, prompt: 'p', ctx: {}, store: createTraceStore({ root: ${JSON.stringify(join(home, 'trace'))} }),
  policy: { stallMs: 0, timeoutMs: 0 } });
process.stdout.write('turn ' + out.outcome + '\\n');
if (stopping) process.exit(0);
`;

let home;
let state;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'seat-stop-proc-'));
  state = null;
});
afterEach(() => {
  if (state) {
    if (state.grandchild) reap(state.grandchild);
    if (state.leader) reap(state.leader);
    state.host.kill('SIGKILL');
  }
  rmSync(home, { recursive: true, force: true });
});

const startHost = async () => {
  const pidFile = join(home, 'grandchild.pid');
  const goFile = join(home, 'go');
  const script = join(home, 'host.mjs');
  writeFileSync(script, HOST({ home, pidFile, goFile }));
  const host = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  state = { host, goFile, out: '' };
  host.stdout.on('data', (chunk) => { state.out += chunk; });
  state.exited = once(host, 'exit');
  expect(await waitFor(() => /ready \d+/.test(state.out))).toBe(true);
  state.leader = Number(state.out.match(/ready (\d+)/)[1]);
  expect(await waitFor(() => existsSync(pidFile) && /^\d+\s*$/.test(readFileSync(pidFile, 'utf8')))).toBe(true);
  state.grandchild = Number(readFileSync(pidFile, 'utf8'));
  return state;
};

const describePosix = POSIX ? describe : describe.skip;

describePosix('seat-stop — real processes', () => {
  test('a seat with a plist: the groups die a margin before ExitTimeOut, mid-turn', async () => {
    // ExitTimeOut 2 s → deadline 1.5 s.
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'me.commonly.seat-probe.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>ExitTimeOut</key><integer>2</integer></dict></plist>');
    await startHost();
    const sent = Date.now();
    state.host.kill('SIGTERM');
    expect(await waitFor(() => /stopping deadline=1500/.test(state.out))).toBe(true);
    await sleep(750);
    expect(isRunning(state.grandchild)).toBe(true);
    expect(await waitFor(() => !isRunning(state.grandchild), 2000)).toBe(true);
    expect(Date.now() - sent).toBeLessThan(2000);
    expect(existsSync(state.goFile)).toBe(false);
  }, 30000);

  test('a seat with no plist: nothing is armed, the turn runs past 15 s, and the groups die on exit', async () => {
    await startHost();
    state.host.kill('SIGTERM');
    expect(await waitFor(() => /stopping deadline=null/.test(state.out))).toBe(true);
    await sleep(16000);
    expect(isRunning(state.grandchild)).toBe(true);
    expect(isRunning(state.leader)).toBe(true);
    writeFileSync(state.goFile, '');
    const [code] = await Promise.race([state.exited, sleep(5000).then(() => ['timeout'])]);
    expect(state.out).toMatch(/turn ok/);
    expect(code).toBe(0);
    expect(await waitFor(() => !isRunning(state.grandchild))).toBe(true);
    expect(await waitFor(() => !isRunning(state.leader))).toBe(true);
  }, 40000);
});
