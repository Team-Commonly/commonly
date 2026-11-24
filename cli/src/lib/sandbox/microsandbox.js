/**
 * The microVM sandbox for native Windows: one microsandbox microVM per turn,
 * booted through the Windows Hypervisor Platform (WHP).
 *
 * Native Windows has neither Seatbelt nor bwrap, so until now a confined seat
 * there either refused or ran unconfined by the person's own choice
 * (windows-unsandboxed.js). This mode is opt-in: it exists only while
 * COMMONLY_SANDBOX_MICROVM=1 is set in the host process, and mode.js is the one
 * place that reads the flag. It is host-resolved, never stored: `microvm` is not
 * an allowed `sandbox.mode` in an environment file (environment.js).
 *
 * The boundary is the VM. What crosses it is built here, in code:
 *   - the network: `--no-net`, DNS, and exact `allow@host:tcp:<port>` rules for
 *     the provider proxy and the MCP bridge. Never a whole-group `allow@host`,
 *     which reaches every service bound to the host's loopback (spike finding 3),
 *     and never `--net-rule` without `--no-net`, which leaves the public
 *     internet open (finding 2);
 *   - the files: the turn folder read-only, the workspace (read-only unless the
 *     seat may write), the seat's own HOME, and the agent install volume;
 *   - no environment on the command line: argv and env travel in a private
 *     turn file that a small entry script reads inside the guest.
 *
 * msb is pinned and checked against the release's own checksums, downloaded into
 * this CLI's own folder, never through microsandbox's install script and never
 * installed globally.
 *
 * Evidence: docs/plans/microsandbox-windows-spike.md. Operator notes:
 * docs/cli/microvm-sandbox.md.
 */
import { createHash, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import {
  MCP_BRIDGE_ENV, MCP_BRIDGE_SECRET_ENV, MCP_SHIM_SOURCE, hostMcpServers, startMcpBridge,
} from './microsandbox-mcp-bridge.js';

export const MICROVM_FLAG_ENV = 'COMMONLY_SANDBOX_MICROVM';
export const microvmFlagOn = (env = process.env) => env?.[MICROVM_FLAG_ENV] === '1';

// microsandbox v0.8.1 (Apache-2.0). Hashes copied from the release's own
// checksums.sha256. Moving the pin is a reviewed change, with the Windows
// workflow run on the new version.
export const MSB_PIN = Object.freeze({
  version: '0.8.1',
  assets: Object.freeze({
    x64: Object.freeze({
      name: 'microsandbox-windows-x86_64.zip',
      sha256: 'b0f57ecbe7ad2abcc30e0dd9aa39de6c5cf31b0824c2b1cf6d4387d1fe88cde2',
    }),
    arm64: Object.freeze({
      name: 'microsandbox-windows-aarch64.zip',
      sha256: '928a957191b3e5b7378c59134b1291773ab75eb55fe607f35467b3d52ac1931d',
    }),
  }),
});

// The guest: Debian with Node (Claude Code and the entry script are Node), pinned
// by index digest. The agent itself lives on a named disk volume, installed once.
export const GUEST_IMAGE = 'node:22-bookworm-slim@sha256:170fab707454b1350981adcdc2f536ec21f24d06d7f008e8d40064afeacb8a94';
export const GUEST_CLAUDE_VERSION = '2.1.331';
export const GUEST_VOLUME = 'commonly-agents';
// Writable only for the one-time install. Every turn mounts it read-only, so
// no seat can replace the Claude Code another seat's next turn runs, and
// concurrent turns never write the same disk image.
export const GUEST_VOLUME_SPEC = `${GUEST_VOLUME}:/opt/agents:kind=disk,size=4G`;
export const GUEST_VOLUME_TURN_SPEC = `${GUEST_VOLUME_SPEC},ro`;
export const GUEST_CLAUDE = '/opt/agents/bin/claude';
export const GUEST_HOST = 'host.microsandbox.internal';
export const GUEST_TURN_DIR = '/run/commonly';
export const GUEST_WORKSPACE = '/workspace';
export const GUEST_HOME = '/home/seat';
export const GUEST_PATH = '/opt/agents/bin:/usr/local/bin:/usr/bin:/bin';
export const GUEST_MCP_CONFIG = `${GUEST_TURN_DIR}/mcp.json`;

export const ENABLE_WHP_COMMAND = 'Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All';

export const msbAsset = (arch = process.arch) => {
  const asset = MSB_PIN.assets[arch];
  if (!asset) throw new Error(`There is no microsandbox build for Windows on ${arch}; the microVM sandbox needs x64 or arm64.`);
  return asset;
};

export const msbReleaseUrl = (asset) => 'https://github.com/superradcompany/microsandbox/releases/download/'
  + `v${MSB_PIN.version}/${asset.name}`;

// Under the person's own local app data, beside nothing shared.
export const microsandboxRoot = (env = process.env) => join(
  env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'commonly', 'microsandbox', MSB_PIN.version,
);

// ── the fence ───────────────────────────────────────────────────────────────

const isPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

/**
 * The guest's whole network: DNS, and the exact host ports named. `--no-net`
 * comes first because microsandbox prepends `--net-rule` to its default policy,
 * which keeps an implicit allow@public, unless a policy flag replaces it.
 */
export const buildMicrovmFence = (ports) => {
  const valid = Array.isArray(ports) && ports.length > 0 && ports.every(isPort)
    && new Set(ports).size === ports.length;
  if (!valid) throw new Error(`microVM fence ports must be distinct TCP ports, got ${JSON.stringify(ports)}`);
  return ['--no-net', '--net-rule', ['allow@dns', ...ports.map((port) => `allow@host:tcp:${port}`)].join(',')];
};

// ── WHP, without admin rights ───────────────────────────────────────────────

// The check msb itself makes (sdk/rust/lib/setup/windows.rs): load
// WinHvPlatform.dll and ask WHvGetCapability for capability 0,
// HypervisorPresent. It needs no elevation, unlike Get-WindowsOptionalFeature.
export const WHP_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CommonlyWhp { [DllImport(\"WinHvPlatform.dll\")] public static extern int WHvGetCapability(int code, out int buffer, int size, out int written); }'",
  '  $buffer = 0; $written = 0',
  '  $hr = [CommonlyWhp]::WHvGetCapability(0, [ref]$buffer, 4, [ref]$written)',
  '  "hr=$hr present=$buffer"',
  '} catch { "nodll" }',
].join('\n');

export const parseWhpProbe = (stdout) => {
  const text = String(stdout || '').trim();
  if (text === 'nodll') {
    return {
      available: false,
      error: 'WinHvPlatform.dll is missing, so the Windows HypervisorPlatform feature is off',
    };
  }
  const match = /^hr=(-?\d+) present=(-?\d+)$/.exec(text);
  if (!match) return { available: false, error: `the hypervisor check gave no answer (${text.slice(0, 80) || 'empty'})` };
  const hr = Number(match[1]);
  if (hr !== 0) {
    return { available: false, error: `WHvGetCapability failed with HRESULT 0x${(hr >>> 0).toString(16).padStart(8, '0')}` };
  }
  if (Number(match[2]) === 0) {
    return {
      available: false,
      error: 'WHP is installed but its hypervisor is not running in this Windows session (reboot after turning it on)',
    };
  }
  return { available: true };
};

export const probeWhp = ({ platform = process.platform, run = spawnSync, env = process.env } = {}) => {
  if (platform !== 'win32') return { available: false, error: 'the microVM sandbox runs only on native Windows' };
  const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = run(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WHP_PROBE_SCRIPT,
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (result?.error) return { available: false, error: `the hypervisor check could not run: ${result.error.message}` };
  return parseWhpProbe(result?.stdout);
};

/**
 * Attach-time check for `sandbox.mode=microvm`. Throws the reason a person can
 * act on; returns nothing when the mode can run here.
 */
export const checkMicrovmAttach = ({
  adapterName, platform = process.platform, env = process.env, probe = probeWhp,
}) => {
  if (platform !== 'win32') throw new Error('sandbox.mode=microvm runs only on native Windows.');
  if (!microvmFlagOn(env)) {
    throw new Error(`sandbox.mode=microvm is opt-in: set ${MICROVM_FLAG_ENV}=1 in the environment that runs this CLI.`);
  }
  if (adapterName !== 'claude') {
    throw new Error(`sandbox.mode=microvm supports only the claude adapter for now, not ${adapterName || 'this one'}.`);
  }
  const whp = probe({ platform, env });
  if (!whp.available) {
    throw new Error(
      `The microVM sandbox needs the Windows Hypervisor Platform, and it is not available: ${whp.error}.\n`
      + 'To turn it on, run PowerShell as Administrator:\n'
      + `  ${ENABLE_WHP_COMMAND}\n`
      + 'then reboot when Windows asks, and attach again.',
    );
  }
};

// ── msb, pinned ─────────────────────────────────────────────────────────────

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// Windows 10 1803+ ships bsdtar as System32\tar.exe, which reads zip. Named by
// its full path so a tar earlier on PATH is never the one run.
const defaultExtract = (archive, dir, env = process.env) => spawnSync(
  join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
  ['-xf', archive, '-C', dir],
  { encoding: 'utf8', windowsHide: true },
);

/**
 * The path of a verified msb.exe for the pinned version, downloading it the
 * first time. A hash mismatch, a failed download or an archive without msb.exe
 * refuses and leaves nothing runnable behind.
 */
export const MSB_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export const ensureMsb = async ({
  root = microsandboxRoot(),
  asset = msbAsset(),
  fetchImpl = globalThis.fetch,
  extract = defaultExtract,
  timeoutMs = MSB_DOWNLOAD_TIMEOUT_MS,
} = {}) => {
  const binary = join(root, 'msb.exe');
  const marker = join(root, '.verified');
  // The marker holds the archive's pinned hash and the hash msb.exe had when
  // it was unpacked; the binary is hashed again on every use.
  try {
    const [archiveSha, binarySha] = readFileSync(marker, 'utf8').trim().split(/\s+/);
    if (archiveSha === asset.sha256 && binarySha && sha256(readFileSync(binary)) === binarySha) return binary;
  } catch { /* not installed yet */ }

  await mkdir(root, { recursive: true });
  const tag = randomBytes(6).toString('hex');
  const archive = join(root, `.download-${tag}.zip`);
  const staging = join(root, `.staging-${tag}`);
  try {
    // One deadline for the request and the body, so a stalled connection
    // can't hold the install lock indefinitely.
    let bytes;
    try {
      const response = await fetchImpl(msbReleaseUrl(asset), { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!response?.ok) throw new Error(`downloading microsandbox ${MSB_PIN.version} failed (HTTP ${response?.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(`downloading microsandbox ${MSB_PIN.version} took longer than ${Math.round(timeoutMs / 1000)} s; try again`);
      }
      throw error;
    }
    const actual = sha256(bytes);
    if (actual !== asset.sha256) {
      throw new Error(`microsandbox ${asset.name} has SHA-256 ${actual}, not the pinned ${asset.sha256}; refusing to run it`);
    }
    await writeFile(archive, bytes);
    await mkdir(staging);
    const result = extract(archive, staging);
    if (result?.error || (result?.status ?? 0) !== 0) {
      throw new Error(`unpacking microsandbox failed: ${result?.error?.message || result?.stderr || `exit ${result?.status}`}`);
    }
    // msb.exe and the libraries beside it, at the top or one folder down.
    const top = await readdir(staging, { withFileTypes: true });
    let from = staging;
    if (!top.some((entry) => entry.isFile() && entry.name === 'msb.exe')) {
      const nested = top.filter((entry) => entry.isDirectory())
        .map((entry) => join(staging, entry.name))
        .filter((dir) => existsSync(join(dir, 'msb.exe')));
      if (nested.length !== 1) {
        throw new Error(`the microsandbox archive holds no msb.exe (found ${top.map((e) => e.name).join(', ') || 'nothing'})`);
      }
      [from] = nested;
    }
    const names = await readdir(from);
    await rm(marker, { force: true });
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      await rm(join(root, name), { recursive: true, force: true });
      // eslint-disable-next-line no-await-in-loop
      await rename(join(from, name), join(root, name));
    }
    await writeFile(marker, `${asset.sha256} ${sha256(readFileSync(binary))}\n`);
    return binary;
  } finally {
    await rm(archive, { force: true }).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
};

// ── the agent install volume ────────────────────────────────────────────────

/**
 * Claude Code inside the guest, on the named disk volume, at the pinned
 * version. The install sandbox has microsandbox's default network (the public
 * internet, nothing on the host) and no secrets; every turn after runs fenced.
 */
export const ensureGuestClaude = ({
  msb, root = microsandboxRoot(), run = spawnSync, log = () => {},
}) => {
  // The volume outlives this CLI's folder only if someone removes the folder,
  // so a marker beside msb says the install already passed once.
  const marker = join(root, `.guest-claude-${GUEST_CLAUDE_VERSION}`);
  if (existsSync(marker)) return { installed: false };
  const runGuest = (command, timeout) => run(msb, [
    'run', '--mount-named', GUEST_VOLUME_SPEC, GUEST_IMAGE, '--', 'sh', '-c', command,
  ], { encoding: 'utf8', timeout, windowsHide: true });
  const probe = runGuest(`${GUEST_CLAUDE} --version 2>/dev/null || true`, 180000);
  if (String(probe?.stdout || '').includes(GUEST_CLAUDE_VERSION)) {
    writeFileSync(marker, `${GUEST_IMAGE}\n`);
    return { installed: false };
  }
  log(`microvm: installing Claude Code ${GUEST_CLAUDE_VERSION} into the ${GUEST_VOLUME} volume (once)`);
  const install = runGuest(
    `npm --prefix /opt/agents i -g --no-fund --no-audit @anthropic-ai/claude-code@${GUEST_CLAUDE_VERSION} >/tmp/npm.log 2>&1`
      + ` && ${GUEST_CLAUDE} --version || (tail -20 /tmp/npm.log; exit 1)`,
    600000,
  );
  if (install?.error || install?.status !== 0 || !String(install?.stdout || '').includes(GUEST_CLAUDE_VERSION)) {
    throw new Error(`installing Claude Code into the microVM volume failed: ${install?.error?.message
      || String(install?.stdout || install?.stderr || '').trim().slice(-600) || `exit ${install?.status}`}`);
  }
  writeFileSync(marker, `${GUEST_IMAGE}\n`);
  return { installed: true };
};

// ── one turn ────────────────────────────────────────────────────────────────

// msb splits SOURCE:DEST[:OPTIONS] on colons other than a drive letter's, and
// options on commas, so a source holding either could add a mount option.
const mountSource = (path, label) => {
  const value = String(path || '');
  const rest = /^[A-Za-z]:[\\/]/.test(value) ? value.slice(2) : value;
  if (!value || rest.includes(':') || value.includes(',')) {
    throw new Error(`the microVM cannot mount the ${label} at ${JSON.stringify(value)}: the path holds a ':' or ','`);
  }
  return value;
};

// The workspace is always read-only here: a writable one would hand the guest
// the project's .git, whose hooks and config the host's own git later runs.
export const buildMicrovmRunArgs = ({
  ports, turnDir, workspace, home, cpus = 2, memory = '2G',
}) => [
  'run',
  '--cpus', String(cpus),
  '--memory', memory,
  ...buildMicrovmFence(ports),
  '--mount-named', GUEST_VOLUME_TURN_SPEC,
  '--mount-dir', `${mountSource(turnDir, 'turn folder')}:${GUEST_TURN_DIR}:ro`,
  '--mount-dir', `${mountSource(workspace, 'workspace')}:${GUEST_WORKSPACE}:ro`,
  '--mount-dir', `${mountSource(home, 'seat home')}:${GUEST_HOME}`,
  '--workdir', GUEST_WORKSPACE,
  GUEST_IMAGE,
  '--',
  'node', `${GUEST_TURN_DIR}/entry.js`,
];

// Runs inside the guest. Reads the turn, starts the agent with exactly that
// env, and exits with its code. Kept tiny: it is the only code we put in the VM.
export const GUEST_ENTRY_SOURCE = `'use strict';
const { readFileSync } = require('fs');
const { spawn } = require('child_process');
const turn = JSON.parse(readFileSync('${GUEST_TURN_DIR}/turn.json', 'utf8'));
const child = spawn(turn.argv[0], turn.argv.slice(1), { stdio: 'inherit', env: turn.env, cwd: turn.cwd });
child.on('error', (error) => { process.stderr.write('commonly microvm entry: ' + error.message + '\\n'); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
`;

const writePrivate = async (path, contents) => {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
};

/** Writes one turn's folder: argv and env, the entry, the guest MCP config and its shim. */
export const writeMicrovmTurn = async (dir, { argv, env, mcpConfig = { mcpServers: {} } }) => {
  await writePrivate(join(dir, 'turn.json'), JSON.stringify({ argv, env, cwd: GUEST_WORKSPACE }));
  await writePrivate(join(dir, 'entry.js'), GUEST_ENTRY_SOURCE);
  await writePrivate(join(dir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
  await writePrivate(join(dir, 'mcp-shim.js'), MCP_SHIM_SOURCE);
};

// The seat's own HOME inside the guest, kept on the host between turns
// (transcripts, Claude's settings). Nothing on the host ever runs from it.
// One per trust, as bwrap keeps a public seat's state apart from the same
// agent's workspace turns.
export const microvmSeatHome = (identity, trust = 'public', env = process.env) => join(
  microsandboxRoot(env), 'seats',
  `${sha256(Buffer.from(String(identity || 'anonymous'))).slice(0, 20)}-${trust === 'workspace' ? 'workspace' : 'public'}`,
);

/** The guest's base URL for the host provider proxy: same port and path, the host alias. */
export const guestProxyBaseUrl = (proxyBaseUrl) => {
  const url = new URL(proxyBaseUrl);
  url.hostname = GUEST_HOST;
  return url.toString();
};

/**
 * Claude's whole environment inside the guest. The provider key is the proxy's
 * per-turn token, never the host's key; nothing else from the host is passed.
 */
export const guestClaudeEnv = ({ proxyBaseUrl, proxyToken }) => ({
  HOME: GUEST_HOME,
  PATH: GUEST_PATH,
  LANG: 'C.UTF-8',
  ANTHROPIC_BASE_URL: guestProxyBaseUrl(proxyBaseUrl),
  ANTHROPIC_API_KEY: proxyToken,
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

/** The guest's MCP config: one shim per host server, each through the bridge. */
export const guestMcpConfig = (names, bridge) => ({
  mcpServers: Object.fromEntries(names.map((name) => [name, {
    type: 'stdio',
    command: 'node',
    args: [`${GUEST_TURN_DIR}/mcp-shim.js`, name],
    env: { [MCP_BRIDGE_ENV]: `${GUEST_HOST}:${bridge.port}`, [MCP_BRIDGE_SECRET_ENV]: bridge.secret },
  }])),
});

/**
 * Host side of one turn: the turn folder, and the MCP bridge for the servers in
 * the host's Claude MCP config (expanded with `vars`, the values Claude would
 * have held). Returns the ports the fence opens and close(), which stops the
 * bridge and removes the folder.
 */
export const startMicrovmTurn = async ({
  proxyPort, hostMcpConfig = null, vars = {}, baseEnv = {}, cwd, serverEnv = {}, startBridge = startMcpBridge,
}) => {
  // The servers run unconfined on the host, so they enforce the seat's limits
  // themselves: `serverEnv` carries them (the withheld tools), and `cwd` is the
  // workspace, the folder a server treats as the seat's own.
  if (!cwd) throw new Error('the microVM MCP bridge needs the workspace as its servers\' folder');
  const servers = hostMcpServers(hostMcpConfig, vars);
  for (const spec of servers.values()) Object.assign(spec.env, serverEnv);
  const turnDir = await mkdtemp(join(tmpdir(), 'commonly-microvm-'));
  let bridge = null;
  try {
    await chmod(turnDir, 0o700);
    if (servers.size) bridge = await startBridge({ servers, baseEnv, cwd });
  } catch (error) {
    await rm(turnDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    turnDir,
    ports: [proxyPort, bridge?.port].filter(Boolean),
    mcpConfig: bridge ? guestMcpConfig([...servers.keys()], bridge) : { mcpServers: {} },
    close: async () => {
      try { await bridge?.close(); } catch { /* ignore */ }
      await rm(turnDir, { recursive: true, force: true }).catch(() => {});
    },
  };
};

const INSTALL_LOCK_STALE_MS = 15 * 60 * 1000;
// Longer than the slowest install can run (a 5-minute download, the volume
// probe and a 10-minute npm install), so a lock older than this was leaked by
// its holder, or names a pid since reused, and is taken over even though that
// pid is alive.
const INSTALL_LOCK_MAX_MS = 60 * 60 * 1000;

const defaultPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, owned by someone else.
    return error?.code === 'EPERM';
  }
};

/**
 * Whether a lock whose file reads `content` can be taken over. The lock lives
 * in this user's %LOCALAPPDATA%, so its holder ran on this machine: it is
 * abandoned once that process is gone, and a slow install is not cut in on
 * while it runs. Past INSTALL_LOCK_MAX_MS it is abandoned whatever the pid, so
 * a lock a live process leaked, or one naming a reused pid, can't wedge every
 * later install. A lock that names no process falls back to the shorter age.
 */
const lockAbandoned = (content, mtimeMs, { now, pidAlive }) => {
  const age = now() - mtimeMs;
  const pid = Number.parseInt(String(content).split(/\s+/)[0], 10);
  if (Number.isInteger(pid) && pid > 0) return age > INSTALL_LOCK_MAX_MS || !pidAlive(pid);
  return age > INSTALL_LOCK_STALE_MS;
};

// The guard is held only for a read and an unlink, so one older than this was
// left by a process that died inside that window.
const INSTALL_LOCK_GUARD_STALE_MS = 30 * 1000;

/**
 * Runs `fn` holding `guard`, a short-lived lock that serialises every removal
 * of the install lock (a takeover or a release), so no removal can act on a
 * lock that changed after it was read.
 */
const withLockGuard = async (guard, fn, { now }) => {
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(guard, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // eslint-disable-next-line no-await-in-loop
      const held = await stat(guard).catch(() => null);
      if (held && now() - held.mtimeMs > INSTALL_LOCK_GUARD_STALE_MS) {
        // eslint-disable-next-line no-await-in-loop
        await rm(guard, { force: true });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
    }
  }
  try {
    return await fn();
  } finally {
    await rm(guard, { force: true }).catch(() => {});
  }
};

/**
 * Runs `fn` holding this version's install lock, so two first turns never
 * unpack msb or install into the volume (mounted writable then) at once.
 *
 * The lock names its holder (`<pid> <token>`, the token unique to each take).
 * Only an exclusive create takes it. A waiter takes over a lock whose process
 * has exited, or one past INSTALL_LOCK_MAX_MS, by deleting it and trying the
 * create again. Every deletion, a takeover or the holder's release, runs under
 * a guard lock and re-reads the lock first, deleting only the exact lock it
 * judged (same token). So a takeover can never delete a lock another waiter
 * took after the judgement, and the lock's path is never free while a live
 * holder's lock is displaced. The holder also removes a lock it can't read at
 * all, so an unreadable lock is never left behind.
 */
export const withInstallLock = async (root, fn, {
  waitMs = INSTALL_LOCK_STALE_MS, pollMs = 500, now = Date.now, pidAlive = defaultPidAlive,
} = {}) => {
  await mkdir(root, { recursive: true });
  const lock = join(root, '.install.lock');
  const guard = join(root, '.install.lock.guard');
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const deadline = now() + waitMs;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(lock, mine, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // eslint-disable-next-line no-await-in-loop
      const held = await stat(lock).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      const judged = held ? await readFile(lock, 'utf8').catch(() => null) : null;
      if (held && judged !== null && lockAbandoned(judged, held.mtimeMs, { now, pidAlive })) {
        // eslint-disable-next-line no-await-in-loop
        await withLockGuard(guard, async () => {
          const current = await readFile(lock, 'utf8').catch(() => null);
          if (current === judged) await rm(lock, { force: true });
        }, { now });
      } else if (now() > deadline) {
        throw new Error(`another turn is still installing the microVM sandbox (${lock}); try again shortly`);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, pollMs); });
      }
    }
  }
  try {
    return await fn();
  } finally {
    await withLockGuard(guard, async () => {
      const current = await readFile(lock, 'utf8').then((text) => text, (error) => error);
      // Not `instanceof Error`: fs errors can come from another realm (a test VM).
      const unreadable = typeof current !== 'string' && current?.code !== 'ENOENT';
      if (current === mine || unreadable) await rm(lock, { recursive: true, force: true });
    }, { now }).catch(() => {});
  }
};

/** msb and the guest's Claude, ready to run a turn. */
export const prepareMicrovmHost = async ({ log, root = microsandboxRoot() } = {}) => withInstallLock(root, async () => {
  const msb = await ensureMsb({ root });
  ensureGuestClaude({ msb, root, log });
  return { msb };
});

/**
 * msb gets the host environment it needs to find its own state and the
 * Windows runtime, and nothing else: no provider key, no agent token.
 */
const MSB_HOST_ENV = new Set([
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive', 'SYSTEMDRIVE', 'ComSpec', 'COMSPEC',
  'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData',
  'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);
export const msbHostEnv = (source = process.env) => Object.fromEntries(
  Object.entries(source || {}).filter(([key]) => MSB_HOST_ENV.has(key)),
);

export default {
  MICROVM_FLAG_ENV,
  startMicrovmTurn,
  buildMicrovmFence,
  buildMicrovmRunArgs,
  checkMicrovmAttach,
  ensureGuestClaude,
  ensureMsb,
  microvmFlagOn,
  probeWhp,
  writeMicrovmTurn,
};
