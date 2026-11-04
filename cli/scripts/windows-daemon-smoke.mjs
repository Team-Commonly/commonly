#!/usr/bin/env node
/**
 * D245 proof on a real Windows host (the windows-latest CI job,
 * .github/workflows/daemon-windows.yml). It installs the daemon as the
 * per-user scheduled task, checks the task is registered, kills the daemon
 * process and sees it come back, kills the launcher too and sees the task's
 * watchdog bring it back, then checks stop, the unsandboxed opt-in on the
 * check-in, and uninstall.
 *
 * The daemon talks to a stub API served from this process: it answers the
 * work list with no agents and counts heartbeats. A heartbeat that arrives
 * after a kill, from a new process, is the proof that the daemon came back and
 * is supervising again, not merely that a process exists.
 *
 * It writes a throwaway machine record into the runner's profile. Never run it
 * on a machine you use: it replaces ~/.commonly/daemon/machine.json.
 */
import { execFile } from 'child_process';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'index.js');
const TASK = 'CommonlyDaemon';
const MACHINE = { machineDbId: 'm-ci', machineId: 'ci-machine', machineName: 'ci-windows' };

if (process.platform !== 'win32') {
  console.error('windows-daemon-smoke: Windows only.');
  process.exit(2);
}
if (!process.env.CI) {
  console.error('windows-daemon-smoke: refuses to run outside CI (it replaces this profile\'s daemon record).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (line) => { console.error(`FAIL: ${line}`); process.exitCode = 1; throw new Error(line); };

// ── stub API ────────────────────────────────────────────────────────────────
const beats = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url.startsWith('/api/agent-binding/assigned')) {
      res.end(JSON.stringify({ agents: [] }));
      return;
    }
    if (req.method === 'POST' && req.url === `/api/machines/${MACHINE.machineDbId}/heartbeat`) {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* counted anyway */ }
      beats.push({ at: Date.now(), body: parsed });
      res.end(JSON.stringify({ machine: { id: MACHINE.machineDbId } }));
      return;
    }
    res.end('{}');
  });
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
const { port } = server.address();
log(`stub API on 127.0.0.1:${port}`);

// ── helpers ─────────────────────────────────────────────────────────────────
const cli = async (...args) => {
  const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, COMMONLY_NO_UPDATE_CHECK: '1' } });
  if (stdout.trim()) log(`commonly ${args.join(' ')}: ${stdout.trim()}`);
  if (stderr.trim()) log(`commonly ${args.join(' ')} (stderr): ${stderr.trim()}`);
  return stdout;
};
const ps = async (script) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).stdout.trim();
const processes = async (needle) => {
  const out = await ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { $_.ProcessId }`);
  return out ? out.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean) : [];
};
const daemonPids = () => processes('daemon run --foreground');
const launcherPids = () => processes('commonly-daemon.ps1');
const taskQuery = async () => {
  try {
    return (await run('schtasks', ['/Query', '/TN', TASK, '/V', '/FO', 'LIST'])).stdout;
  } catch {
    return null;
  }
};
const waitFor = async (what, check, timeoutMs) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const value = await check();
    if (value) {
      log(`${what}: after ${Math.round((Date.now() - start) / 1000)} s`);
      return value;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(2000);
  }
  return fail(`${what}: not within ${Math.round(timeoutMs / 1000)} s`);
};
const beatSince = (t) => () => beats.find((b) => b.at > t);
// Every install, restart and watchdog start must leave ONE daemon: schtasks /End kills the launcher
// only, so a daemon that did not follow its launcher out showed up here as two (11-04).
const exactlyOneDaemon = async (when) => {
  await sleep(8000);
  const pids = await daemonPids();
  if (pids.length !== 1) fail(`${when}: expected one daemon process, found ${pids.length} (${pids.join(', ')})`);
  log(`${when}: one daemon (${pids[0]})`);
  return pids;
};
const newDaemonPid = (old) => async () => (await daemonPids()).find((p) => !old.includes(p));

const dumpLogs = () => {
  for (const file of [join(homedir(), '.commonly', 'logs', 'daemon', 'daemon.log')]) {
    if (existsSync(file)) console.log(`--- ${file}\n${readFileSync(file, 'utf8').slice(-4000)}`);
  }
};

try {
  // ── a registered machine pointing at the stub ─────────────────────────────
  const record = join(homedir(), '.commonly', 'daemon', 'machine.json');
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, `${JSON.stringify({ ...MACHINE, instanceUrl: `http://127.0.0.1:${port}`, daemonToken: 'cm_daemon_ci_only' })}\n`);

  // ── install: the task is registered and the daemon checks in ──────────────
  await cli('daemon', 'install');
  const query = await taskQuery();
  if (!query) fail('the scheduled task is not registered after install');
  log(`task registered:\n${query.split(/\r?\n/).filter((l) => /TaskName|Status|Logon Mode|Run As User|Task To Run|Scheduled Task State/.test(l)).join('\n')}`);
  const installedAt = Date.now() - 1000;
  await waitFor('first check-in after install', beatSince(installedAt), 90_000);
  const first = await waitFor('daemon process', daemonPids, 30_000);
  if (beats.at(-1).body.sandbox !== 'native-windows') fail(`a default install reported sandbox ${JSON.stringify(beats.at(-1).body.sandbox)}`);
  await exactlyOneDaemon('after install');

  // ── kill the daemon: the launcher restarts it ─────────────────────────────
  const killedAt = Date.now();
  await run('taskkill', ['/F', '/PID', String(first[0])]);
  log(`killed daemon pid ${first[0]}`);
  await waitFor('daemon back after kill (new pid)', newDaemonPid(first), 60_000);
  await waitFor('check-in from the restarted daemon', beatSince(killedAt + 1000), 60_000);
  await exactlyOneDaemon('after the launcher restarted it');

  // ── kill the launcher and the daemon: the task's watchdog brings it back ──
  const before = [...await daemonPids(), ...await launcherPids()];
  const watchdogAt = Date.now();
  for (const pid of before) {
    // eslint-disable-next-line no-await-in-loop
    await run('taskkill', ['/F', '/PID', String(pid)]).catch(() => {});
  }
  log(`killed launcher and daemon (${before.join(', ')})`);
  await waitFor('daemon back after the launcher was killed (watchdog)', newDaemonPid(before), 150_000);
  await waitFor('check-in after the watchdog restart', beatSince(watchdogAt + 1000), 60_000);
  await exactlyOneDaemon('after the watchdog restart');

  // ── killing only the launcher takes its daemon with it, then the watchdog restarts both
  const onlyLauncher = await launcherPids();
  const daemonBefore = await daemonPids();
  await run('taskkill', ['/F', '/PID', String(onlyLauncher[0])]);
  log(`killed only the launcher (${onlyLauncher[0]})`);
  await waitFor('its daemon exits with it', async () => !(await daemonPids()).some((p) => daemonBefore.includes(p)), 30_000);
  await waitFor('daemon back via the watchdog', newDaemonPid(daemonBefore), 150_000);
  await exactlyOneDaemon('after the launcher-only kill');

  // ── the unsandboxed opt-in reaches the check-in, and installing without it removes it
  await cli('daemon', 'install', '--unsandboxed');
  const optedAt = Date.now();
  await waitFor('check-in carrying the opt-in', () => beats.find((b) => b.at > optedAt && b.body.sandbox === 'unsandboxed-opted-in'), 90_000);
  await exactlyOneDaemon('after install --unsandboxed');
  await cli('daemon', 'install');
  const clearedAt = Date.now();
  await waitFor('check-in without the opt-in after a plain install', () => beats.find((b) => b.at > clearedAt + 1000 && b.body.sandbox === 'native-windows'), 90_000);
  const [plain] = await exactlyOneDaemon('after a plain reinstall');
  // With one daemon left, every check-in from here on must come without the opt-in.
  const plainAt = Date.now();
  await sleep(35_000);
  if (beats.some((b) => b.at > plainAt && b.body.sandbox !== 'native-windows')) fail(`a check-in still carried the opt-in after a plain reinstall (daemon ${plain})`);

  // ── stop: disabled, nothing running, and the watchdog does not restart it
  await cli('daemon', 'stop');
  await waitFor('no daemon process after stop', async () => (await daemonPids()).length === 0, 30_000);
  const stoppedAt = Date.now();
  await sleep(75_000);
  if ((await daemonPids()).length) fail('the daemon came back after stop');
  if (beats.some((b) => b.at > stoppedAt + 5000)) fail('a check-in arrived after stop');
  if (!/Disabled/i.test(await taskQuery())) fail('the task is not disabled after stop');
  log('stopped and stayed stopped through a watchdog interval');

  // ── uninstall: the task and its files are gone ────────────────────────────
  await cli('daemon', 'uninstall');
  if (await taskQuery()) fail('the scheduled task still exists after uninstall');
  const serviceDir = join(homedir(), '.commonly', 'daemon', 'service');
  for (const name of ['commonly-daemon-task.xml', 'commonly-daemon.ps1', 'service-env.json']) {
    if (existsSync(join(serviceDir, name))) fail(`${name} left behind after uninstall`);
  }
  log(`PASS: ${beats.length} check-ins seen`);
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error.stack || error.message);
  dumpLogs();
  await run('schtasks', ['/Delete', '/TN', TASK, '/F']).catch(() => {});
} finally {
  server.close();
}
process.exit(process.exitCode || 0);
