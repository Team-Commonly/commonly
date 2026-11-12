#!/usr/bin/env node
/**
 * F467: the computer-setup line the Bring your own page shows, run as a person
 * pastes it, on a real Windows or macOS host (daemon-setup-line.yml).
 *
 * The line comes from the page's own source
 * (frontend/src/v2/utils/daemonSetupCommand.ts, loaded with Node's type
 * stripping), so a copy edit there is what runs here. It runs through npx, so it
 * exercises the PUBLISHED @commonlyai/cli: npx fetches it, `daemon setup`
 * installs the stable copy under $HOME, logs in, registers this computer and
 * installs the login service. The proof is a check-in from the service-started
 * daemon, not the line's exit code.
 *
 * Windows runs it in Windows PowerShell 5.1 with the Restricted script policy,
 * the shell and policy a stock Windows 11 account opens: a bare `npx` resolves
 * to npx.ps1 there and is refused (F342), so the page's npx.cmd form is what's
 * tested. macOS runs it in zsh.
 *
 * The API is a stub served from this process. It approves the device login at
 * once and answers the daemon's work list with no agents.
 *
 * It writes ~/.commonly and installs a login service for this account. Never
 * run it on a machine you use.
 */
import { execFile, spawn } from 'child_process';
import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { promisify } from 'util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const UTIL = resolve(HERE, '..', '..', 'frontend', 'src', 'v2', 'utils', 'daemonSetupCommand.ts');
const WINDOWS = process.platform === 'win32';

if (!['win32', 'darwin'].includes(process.platform)) {
  console.error('daemon-setup-line-smoke: Windows or macOS only.');
  process.exit(2);
}
if (!process.env.CI) {
  console.error('daemon-setup-line-smoke: refuses to run outside CI (it installs a login service for this account).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (line) => { console.error(`FAIL: ${line}`); process.exitCode = 1; throw new Error(line); };

// ── stub API ────────────────────────────────────────────────────────────────
const MACHINE = { id: 'm-ci', machineId: 'ci-machine', name: 'ci-setup-line' };
const seen = [];
const beats = [];
let base = '';
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const path = req.url.split('?')[0];
    seen.push(`${req.method} ${path}`);
    res.setHeader('content-type', 'application/json');
    const send = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
    if (req.method === 'POST' && path === '/api/auth/device/start') {
      return send(200, { deviceCode: 'dc-ci', userCode: 'CICI-0000', verifyUrl: `${base}/cli/authorize`, interval: 1, expiresIn: 600 });
    }
    if (req.method === 'POST' && path === '/api/auth/device/poll') {
      return send(200, { status: 'authorized', token: 'cm_ci_only_device', userId: 'u-ci', username: 'ci-user' });
    }
    if (req.method === 'POST' && path === '/api/machines') return send(201, { machine: MACHINE, daemonToken: 'cm_ci_only_daemon' });
    if (req.method === 'GET' && path === '/api/machines/me') return send(200, { machine: MACHINE });
    if (req.method === 'POST' && path === `/api/machines/${MACHINE.id}/heartbeat`) {
      beats.push(Date.now());
      return send(200, { machine: { id: MACHINE.id } });
    }
    if (req.method === 'GET' && path === '/api/agent-binding/assigned') return send(200, { agents: [] });
    return send(404, { message: 'not in the stub' });
  });
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
log(`stub API on ${base}`);

// ── the page's line, from the page's source ─────────────────────────────────
// The util imports the page's API-base helper; the stub URL is passed instead,
// so that import is swapped for a stand-in and the rest is loaded as written.
const loadUtil = async () => {
  const source = readFileSync(UTIL, 'utf8');
  const importLine = /^import getApiBaseUrl from '[^']+';$/m;
  if (!importLine.test(source)) fail(`${UTIL} no longer imports getApiBaseUrl the way this smoke expects`);
  const dir = mkdtempSync(join(tmpdir(), 'setup-line-'));
  const file = join(dir, 'daemonSetupCommand.ts');
  writeFileSync(file, source.replace(importLine, "const getApiBaseUrl = (): string => '';"));
  return import(pathToFileURL(file).href);
};
const { daemonSetupCommandFor } = await loadUtil();
const line = daemonSetupCommandFor(WINDOWS ? 'windows' : 'unix', base);
log(`the page's line: ${line}`);

const dumpLogs = () => {
  const file = join(homedir(), '.commonly', 'logs', 'daemon', 'daemon.log');
  if (existsSync(file)) console.log(`--- ${file}\n${readFileSync(file, 'utf8').slice(-4000)}`);
  console.log(`--- stub saw: ${[...new Set(seen)].join(' · ')}`);
};

const paste = (command) => new Promise((resolvePaste) => {
  const [shell, args] = WINDOWS
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', command]]
    : ['/bin/zsh', ['-c', command]];
  const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COMMONLY_NO_UPDATE_CHECK: '1' } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
  child.stderr.on('data', (c) => { out += c; process.stderr.write(c); });
  child.on('close', (code) => resolvePaste({ code, out }));
});

try {
  const pastedAt = Date.now();
  const { code } = await paste(line);
  if (code !== 0) fail(`the line exited ${code}`);
  log(`the line finished in ${Math.round((Date.now() - pastedAt) / 1000)} s`);
  for (const step of ['POST /api/auth/device/start', 'POST /api/auth/device/poll', 'POST /api/machines']) {
    if (!seen.includes(step)) fail(`setup never called ${step}`);
  }
  const stable = join(homedir(), '.commonly', 'cli', 'node_modules', '@commonlyai', 'cli', 'package.json');
  if (!existsSync(stable)) fail(`no stable CLI at ${stable}`);
  log(`stable CLI ${JSON.parse(readFileSync(stable, 'utf8')).version}`);

  // The line returning is not the proof: the service it installed must start a
  // daemon that checks in on its own.
  const start = Date.now();
  while (!beats.some((t) => t >= pastedAt) && Date.now() - start < 120_000) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(2000);
  }
  if (!beats.some((t) => t >= pastedAt)) fail('no check-in from the service-started daemon within 120 s');
  log(`the daemon checked in ${Math.round((Date.now() - pastedAt) / 1000)} s after the paste`);
} catch (error) {
  dumpLogs();
  if (!process.exitCode) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  const entry = join(homedir(), '.commonly', 'cli', 'node_modules', '@commonlyai', 'cli', 'src', 'index.js');
  if (existsSync(entry)) {
    await run(process.execPath, [entry, 'daemon', 'uninstall'], { env: { ...process.env, COMMONLY_NO_UPDATE_CHECK: '1' } })
      .then(() => log('daemon uninstalled'))
      .catch((error) => log(`uninstall: ${error.message}`));
  }
  server.close();
}
