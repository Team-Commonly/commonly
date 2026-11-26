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
  chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { isShippedCommonlyMcpCommand } from '../declared-mcp-guard.js';
import { describeMcpCommand } from '../mcp-server-version.js';
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
// Codex beside it on the same volume, from its own npm package (the musl Linux
// binary rides in as an optional dependency). The spike ran this version in
// the guest, through the provider proxy, with only DNS and two ports open.
export const GUEST_CODEX_VERSION = '0.172.0';
export const GUEST_CODEX = '/opt/agents/bin/codex';
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

// The adapters that run a turn inside the VM. Every other one refuses the mode.
export const MICROVM_ADAPTERS = new Set(['claude', 'codex']);

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
  if (!MICROVM_ADAPTERS.has(adapterName)) {
    throw new Error('sandbox.mode=microvm supports only the claude adapter and the codex adapter for now, '
      + `not ${adapterName || 'this one'}.`);
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

/**
 * Refuses an MCP declaration the microVM Codex turn can never run: anything
 * but a stdio server with a command (an HTTP or SSE server, the grant broker
 * included), and any stdio server that is not the Commonly MCP server (the
 * shipped `npx -y @commonlyai/mcp` spec, or a build whose package.json names
 * it). Run at attach, before any registry write, and on every turn. The turn
 * resolves only the shipped spec to a home build (mcp-home.js planMcpSpawn),
 * so judging the declared command here refuses the same set it would.
 */
export const refuseMicrovmMcpDeclarations = (servers, { describe = describeMcpCommand } = {}) => {
  for (const server of servers || []) {
    if (!server?.name) continue;
    const transport = typeof server.transport === 'string' ? server.transport.trim().toLowerCase() : 'stdio';
    if (transport !== 'stdio' || !Array.isArray(server.command) || !server.command.length) {
      throw new Error(`The microVM sandbox runs only the Commonly MCP server, over stdio, and ${server.name} `
        + `is ${transport === 'stdio' ? 'declared without a command' : `a ${transport} server`}. `
        + 'Remove it to run this seat in the microVM.');
    }
    if (!(isShippedCommonlyMcpCommand(server.command) || Boolean(describe(server.command)?.isCommonly))) {
      throw new Error(`The microVM sandbox runs only the Commonly MCP server, on this computer, and ${server.name} `
        + 'is another server: it would run outside the VM. Remove it to run this seat in the microVM.');
    }
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

// The agents a turn can run, each installed once onto the volume from npm at
// its pinned version. Both share the volume's npm prefix, so installing one
// leaves the other in place.
export const GUEST_AGENTS = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code', pkg: '@anthropic-ai/claude-code', version: GUEST_CLAUDE_VERSION, bin: GUEST_CLAUDE,
  }),
  codex: Object.freeze({
    label: 'Codex', pkg: '@openai/codex', version: GUEST_CODEX_VERSION, bin: GUEST_CODEX,
  }),
});

/**
 * An agent inside the guest, on the named disk volume, at its pinned version.
 * The install sandbox has microsandbox's default network (the public internet,
 * nothing on the host) and no secrets; every turn after runs fenced.
 */
/**
 * Whether `--version` output reports exactly `version`: some line's version
 * token (`2.1.331 (Claude Code)`, `codex-cli 0.172.0`) equals it, so
 * `10.172.0` or `0.172.01` never passes for `0.172.0`.
 */
export const reportsVersion = (stdout, version) => String(stdout || '').split(/\r?\n/).some((line) => {
  const token = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/.exec(line.trim());
  return token?.[1] === version;
});

export const ensureGuestAgent = ({
  agent = 'claude', msb, root = microsandboxRoot(), run = spawnSync, log = () => {},
}) => {
  const spec = GUEST_AGENTS[agent];
  if (!spec) throw new Error(`the microVM sandbox has no guest install for ${agent}`);
  // The volume outlives this CLI's folder only if someone removes the folder,
  // so a marker beside msb says the install already passed once.
  const marker = join(root, `.guest-${agent}-${spec.version}`);
  if (existsSync(marker)) return { installed: false };
  const runGuest = (command, timeout) => run(msb, [
    'run', '--mount-named', GUEST_VOLUME_SPEC, GUEST_IMAGE, '--', 'sh', '-c', command,
  ], { encoding: 'utf8', timeout, windowsHide: true });
  const probe = runGuest(`${spec.bin} --version 2>/dev/null || true`, 180000);
  if (reportsVersion(probe?.stdout, spec.version)) {
    writeFileSync(marker, `${GUEST_IMAGE}\n`);
    return { installed: false };
  }
  log(`microvm: installing ${spec.label} ${spec.version} into the ${GUEST_VOLUME} volume (once)`);
  const install = runGuest(
    `npm --prefix /opt/agents i -g --no-fund --no-audit ${spec.pkg}@${spec.version} >/tmp/npm.log 2>&1`
      + ` && ${spec.bin} --version || (tail -20 /tmp/npm.log; exit 1)`,
    600000,
  );
  if (install?.error || install?.status !== 0 || !reportsVersion(install?.stdout, spec.version)) {
    throw new Error(`installing ${spec.label} into the microVM volume failed: ${install?.error?.message
      || String(install?.stdout || install?.stderr || '').trim().slice(-600) || `exit ${install?.status}`}`);
  }
  writeFileSync(marker, `${GUEST_IMAGE}\n`);
  return { installed: true };
};

/** Claude Code on the volume (ensureGuestAgent for claude). */
export const ensureGuestClaude = (options) => ensureGuestAgent({ ...options, agent: 'claude' });

/** Codex on the volume (ensureGuestAgent for codex). */
export const ensureGuestCodex = (options) => ensureGuestAgent({ ...options, agent: 'codex' });

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
// `labels`: KEY=VALUE pairs msb keeps on the VM, so a later turn can find this
// one by its seat (ensureNoSeatVm). Only the Codex turn passes one.
export const buildMicrovmRunArgs = ({
  ports, turnDir, workspace, home, cpus = 2, memory = '2G', labels = [],
}) => [
  'run',
  '--cpus', String(cpus),
  '--memory', memory,
  ...labels.flatMap((label) => ['--label', label]),
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

// ── one seat, one VM ────────────────────────────────────────────────────────

// The host checks every path under a seat HOME before it touches it, which is
// sound only while no VM has that HOME mounted. Killing msb.exe (a timeout, a
// cancel) does not stop the VM: msb runs it as a process of its own and stops
// it only on its own exit path. So each Codex turn's VM carries its seat's
// label, and before the host touches the HOME it asks msb for every VM with
// that label, force-stops any still alive, and asks again.

export const MICROVM_SEAT_LABEL_KEY = 'commonly-seat';

/** The label of a seat's VMs: the seat HOME's folder name (a hash and the trust). */
export const microvmSeatLabel = (home) => `${MICROVM_SEAT_LABEL_KEY}=${basename(String(home || ''))}`;

// msb's settled statuses (SandboxStatus); a VM in any other may hold the mount.
const MICROVM_SETTLED_STATUSES = new Set(['Stopped', 'Crashed']);

const seatBusy = (message) => Object.assign(
  new Error(`the microVM sandbox will not touch this seat's HOME: ${message}`),
  { code: 'microvm_seat_busy' },
);

/**
 * Confirms no VM of this seat is alive, force-stopping any that is, by msb's
 * own record: `msb list --label` (which checks each VM's process is alive)
 * and `msb stop --force` (which kills the VM's process and waits for it to
 * exit). Throws `microvm_seat_busy` whenever it can't confirm: msb fails, its
 * answer can't be read, or a VM is still alive after the stop. Another seat's
 * VMs carry another label and are never listed or stopped.
 */
export const ensureNoSeatVm = ({
  msb, label, run = spawnSync, env = process.env, log = () => {}, timeoutMs = 60000,
}) => {
  if (!msb || !label || !label.startsWith(`${MICROVM_SEAT_LABEL_KEY}=`) || label.endsWith('=')) {
    throw seatBusy('there is no msb or no seat label to look its VMs up by');
  }
  const options = {
    encoding: 'utf8', env, timeout: timeoutMs, windowsHide: true,
  };
  const live = () => {
    const listed = run(msb, ['list', '--label', label, '--format', 'json'], options);
    if (listed?.error || listed?.status !== 0) {
      throw seatBusy(`msb could not list its VMs (${listed?.error?.message
        || String(listed?.stderr || '').trim().slice(-300) || `exit ${listed?.status}`})`);
    }
    let entries;
    try {
      // msb list --format json prints an array even when nothing matches, so a
      // blank answer is no inventory, never an empty one.
      entries = JSON.parse(String(listed.stdout || '').trim());
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries)) throw seatBusy('msb\'s list of VMs could not be read');
    return entries.filter((entry) => !MICROVM_SETTLED_STATUSES.has(String(entry?.status)));
  };
  const before = live();
  if (!before.length) return { stopped: [] };
  const names = before.map((entry) => String(entry?.name || ''));
  if (names.some((name) => !name)) throw seatBusy('msb listed a VM of this seat with no name to stop it by');
  for (const name of names) {
    log(`microvm: stopping ${name}, a VM of this seat still running from an earlier turn`);
    run(msb, ['stop', '--force', '--quiet', '--', name], options);
  }
  const after = live();
  if (after.length) {
    throw seatBusy(`${after.map((entry) => `${entry?.name} (${entry?.status})`).join(', ')} is still `
      + 'running after msb stop --force; stop or remove it (msb stop, msb rm) and the next turn runs');
  }
  return { stopped: names };
};

// Every msb.exe on this computer with its command line, as a JSON array
// (`[]` when there is none, so a blank answer is never read as "none").
export const MSB_PROCESS_LIST_SCRIPT = "$ErrorActionPreference = 'Stop'; "
  + 'ConvertTo-Json -Compress -Depth 2 -InputObject @(Get-CimInstance Win32_Process '
  + "-Filter \"Name='msb.exe'\" | Select-Object ProcessId,CommandLine)";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Kills every msb.exe whose command line names this seat (its label, or its
 * HOME as a mount source), and confirms they are gone. Such a process is an
 * `msb run` whose `agent run` died (a hard kill): it takes no seat lock and
 * could boot a VM after ensureNoSeatVm has looked. Called under the seat lock,
 * before that check, so once it returns nothing can start a VM of the seat.
 * Windows only (the mode runs nowhere else); the listing goes through
 * PowerShell's Get-CimInstance, and a listing that fails or can't be read
 * refuses the turn (`microvm_seat_busy`).
 */
export const stopOrphanSeatMsb = ({
  label, home, platform = process.platform, run = spawnSync, kill = (pid) => process.kill(pid),
  env = process.env, log = () => {}, attempts = 25, pollMs = 200,
}) => {
  if (platform !== 'win32') return { stopped: [] };
  if (!label || !home) throw seatBusy('there is no seat label or HOME to find its msb processes by');
  const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(`(?:${escape(label)}(?=$|[\\s"'])|${escape(home)}(?=[:"'\\s]))`, 'i');
  const seatMsb = () => {
    const listed = run(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', MSB_PROCESS_LIST_SCRIPT,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (listed?.error || listed?.status !== 0) {
      throw seatBusy(`the msb processes could not be listed (${listed?.error?.message
        || String(listed?.stderr || '').trim().slice(-300) || `exit ${listed?.status}`})`);
    }
    let entries = null;
    try {
      entries = JSON.parse(String(listed.stdout || '').trim());
    } catch { /* below */ }
    if (!Array.isArray(entries)) throw seatBusy('the list of msb processes could not be read');
    return entries
      .filter((entry) => names.test(String(entry?.CommandLine || '')))
      .map((entry) => Number(entry?.ProcessId))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  };
  const found = seatMsb();
  if (!found.length) return { stopped: [] };
  for (const pid of found) {
    log(`microvm: killing msb.exe ${pid}, left running for this seat by an earlier agent run`);
    try { kill(pid); } catch { /* confirmed below */ }
  }
  let left = seatMsb();
  for (let i = 1; i < attempts && left.length; i += 1) {
    sleepSync(pollMs);
    left = seatMsb();
  }
  if (left.length) throw seatBusy(`msb.exe ${left.join(', ')} of this seat is still running after being killed`);
  return { stopped: found };
};

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
const lockAbandoned = (content, mtimeMs, {
  now, pidAlive, maxMs = INSTALL_LOCK_MAX_MS, staleMs = INSTALL_LOCK_STALE_MS,
}) => {
  const age = now() - mtimeMs;
  const pid = Number.parseInt(String(content).split(/\s+/)[0], 10);
  if (Number.isInteger(pid) && pid > 0) return age > maxMs || !pidAlive(pid);
  return age > staleMs;
};

// How long a release keeps trying a lock or guard that Windows won't move
// (another handle on it, an antivirus scan say) before leaving it to the
// next waiter's takeover rules.
const LOCK_RELEASE_RETRY_MS = 5 * 1000;

// How long a guard holder may act: it is held only for a read and a removal.
// The guard reads `<pid> <token> <deadline>`, and its holder acts on the lock
// only before that deadline.
const LOCK_GUARD_HOLD_MS = 30 * 1000;

/**
 * Removes `path` only if the file there is the one `isJudged(content, stat)`
 * accepts. The file is first moved, atomically, to a name only this call
 * knows, and judged there, so the file judged is the file removed. One that
 * is not the judged file is put back with a no-clobber link; if the path was
 * taken meanwhile, the moved file is dropped (its holder's own release then
 * finds a lock that is not its own and leaves it). Returns 'gone' (nothing
 * there), 'busy' (Windows would not move it now), 'removed' or 'kept'.
 */
export const removeIfJudged = async (path, isJudged, { io = { rename, stat, readFile, link, rm } } = {}) => {
  const aside = `${path}.${randomBytes(8).toString('hex')}.aside`;
  try {
    await io.rename(path, aside);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'gone';
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) return 'busy';
    throw error;
  }
  const held = await io.stat(aside).catch(() => null);
  const content = await io.readFile(aside, 'utf8').catch(() => null);
  if (isJudged(content, held)) {
    await io.rm(aside, { recursive: true, force: true });
    return 'removed';
  }
  try {
    await io.link(aside, path);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      // No hard links on this filesystem: move it back if the path is still free.
      const free = await io.stat(path).then(() => false, (e) => e?.code === 'ENOENT');
      if (free) {
        await io.rename(aside, path).catch(() => {});
        return 'kept';
      }
    }
  }
  await io.rm(aside, { recursive: true, force: true });
  return 'kept';
};

/**
 * Runs `fn(stillMine)` holding `guard`, a short-lived lock that serialises
 * every removal of the lock (a takeover or a release). A guard is taken over
 * only as seatLockAbandoned says (its pid gone, or its own deadline passed;
 * never on age while its holder may act), through removeIfJudged, so a
 * waiter never removes a guard another waiter has just taken. `stillMine()`
 * is false once this holder's deadline has passed, and the holder then
 * removes nothing. Past `until` (when given), a waiter stops with `busy()`.
 */
const withLockGuard = async (guard, fn, {
  now, pidAlive = defaultPidAlive, until = Infinity, busy = () => new Error(`${guard} is held`), remove = removeIfJudged,
}) => {
  const token = randomBytes(8).toString('hex');
  let mine;
  let deadline;
  for (;;) {
    deadline = now() + LOCK_GUARD_HOLD_MS;
    mine = `${process.pid} ${token} ${deadline}\n`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(guard, mine, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // eslint-disable-next-line no-await-in-loop
      const held = await stat(guard).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      const content = held ? await readFile(guard, 'utf8').catch(() => null) : null;
      if (held && content !== null && seatLockAbandoned(content, held.mtimeMs, {
        now, pidAlive, graceMs: LOCK_GUARD_HOLD_MS,
      })) {
        // eslint-disable-next-line no-await-in-loop
        const removal = await remove(guard, (c, st) => c === content && st?.ino === held.ino);
        // Windows wouldn't move it now (another handle on it): wait like a
        // live holder, within `until`, rather than spin on it.
        if (removal === 'busy') {
          if (now() > until) throw busy();
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
      } else if (now() > until) {
        throw busy();
      } else {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
    }
  }
  const stillMine = () => now() <= deadline;
  try {
    return await fn(stillMine);
  } finally {
    // Past its deadline the guard may be another's already: leave it. A guard
    // Windows won't move now is tried again for a few seconds, each attempt
    // judging it afresh as ours.
    const releaseUntil = now() + LOCK_RELEASE_RETRY_MS;
    while (stillMine()) {
      // eslint-disable-next-line no-await-in-loop
      const released = await remove(guard, (c) => c === mine).catch(() => 'failed');
      if (released !== 'busy' || now() > releaseUntil) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
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
export const withInstallLock = (root, fn, {
  waitMs = INSTALL_LOCK_STALE_MS, pollMs = 500, now = Date.now, pidAlive = defaultPidAlive, _remove,
} = {}) => withFileLock(root, '.install.lock', fn, {
  waitMs,
  pollMs,
  now,
  pidAlive,
  ...(_remove ? { remove: _remove } : {}),
  abandoned: (content, mtimeMs) => lockAbandoned(content, mtimeMs, { now, pidAlive }),
  busy: (lock) => new Error(`another turn is still installing the microVM sandbox (${lock}); try again shortly`),
});

// The lock withInstallLock describes, at `<root>/<name>`. `abandoned(content,
// mtimeMs)` judges a held lock; `busy(lock)` is the error once `waitMs` has
// passed; `suffix` is extra holder text after `<pid> <token>`.
//
// A takeover judges the lock twice: once unguarded, then again under the guard
// from a fresh stat and read of the same file, and it deletes only when the
// guarded pair is still abandoned and reads exactly what was judged. So the age
// of a lock that was replaced in between (its new holder still writing an
// empty file) is never applied to the replacement.
const withFileLock = async (root, name, fn, {
  waitMs, pollMs = 500, now = Date.now, busy, abandoned, suffix = () => '', pidAlive = defaultPidAlive,
  remove = removeIfJudged,
}) => {
  await mkdir(root, { recursive: true });
  const lock = join(root, name);
  const guard = join(root, `${name}.guard`);
  const token = randomBytes(8).toString('hex');
  let mine = null;
  const deadline = now() + waitMs;
  const observe = async () => {
    const held = await stat(lock).catch(() => null);
    const content = held ? await readFile(lock, 'utf8').catch(() => null) : null;
    return held && content !== null ? { held, content } : null;
  };
  for (;;) {
    try {
      // Built at each try, so a suffix naming a time counts from the take.
      mine = `${process.pid} ${token}${suffix()}\n`;
      // eslint-disable-next-line no-await-in-loop
      await writeFile(lock, mine, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // eslint-disable-next-line no-await-in-loop
      const seen = await observe();
      if (seen && abandoned(seen.content, seen.held.mtimeMs)) {
        // The file judged is the file removed: removeIfJudged moves it aside
        // and checks it there against the judgement.
        const isJudged = (content, held) => content === seen.content && held?.ino === seen.held.ino
          && held.mtimeMs === seen.held.mtimeMs && abandoned(content, held.mtimeMs);
        // eslint-disable-next-line no-await-in-loop
        const removal = await withLockGuard(guard, async (stillMine) => {
          const again = await observe();
          if (again && isJudged(again.content, again.held) && stillMine()) return remove(lock, isJudged);
          return 'kept';
        }, {
          now, pidAlive, until: deadline, busy: () => busy(lock), remove,
        });
        // Windows wouldn't move the abandoned lock now (another handle on it):
        // wait and judge it again, within `waitMs`, rather than spin on it.
        if (removal === 'busy') {
          if (now() > deadline) throw busy(lock);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, pollMs); });
        }
      } else if (now() > deadline) {
        throw busy(lock);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, pollMs); });
      }
    }
  }
  try {
    return await fn();
  } finally {
    // The release, under the guard. The lock is read first, and only a file
    // read as ours, or one that can't be read at all (never left behind), is
    // moved aside, and is judged again there. A lock that is not ours (a
    // successor's, after a takeover) is never renamed: moving it would free
    // the path for a moment, and a third turn's create could win it. Every
    // removal runs under the guard, so nothing replaces the lock between this
    // read and the move. Windows refusing the move ('busy') is retried for a
    // few seconds, each attempt reading afresh.
    const releaseUntil = now() + LOCK_RELEASE_RETRY_MS;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const released = await withLockGuard(guard, async (stillMine) => {
        if (!stillMine()) return 'kept';
        const held = await stat(lock).catch((error) => error);
        if (held?.code === 'ENOENT') return 'gone';
        const read = await readFile(lock, 'utf8').then((text) => ({ text }), (error) => ({ error }));
        if (['EBUSY', 'EPERM', 'EACCES'].includes(read.error?.code)) return 'busy';
        const unreadable = Boolean(read.error);
        if (!unreadable && read.text !== mine) return 'kept';
        return remove(lock, (content, st) => (unreadable ? content === null : content === mine)
          && (typeof held?.ino !== 'number' || st?.ino === held.ino));
      }, {
        // A guard another holds frees within its 30-second deadline: wait that out.
        now, pidAlive, remove, until: releaseUntil + LOCK_GUARD_HOLD_MS,
      }).catch(() => 'failed');
      if (released !== 'busy' || now() > releaseUntil) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, Math.min(pollMs, 100)); });
    }
  }
};

// How long a second turn of a seat waits for the first before refusing.
export const SEAT_LOCK_WAIT_MS = 2 * 60 * 1000;

// A lock file that names no holder yet is one whose holder is between its
// exclusive create and its write; only past this age is it taken as left by a
// process that died in that window.
const SEAT_LOCK_EMPTY_GRACE_MS = 60 * 1000;

/**
 * Whether a seat lock reading `content` can be taken over. Never on age alone,
 * and never from a holder that may still act on the HOME:
 * - its pid is gone (pidAlive false; EPERM counts as alive), or
 * - the deadline the holder wrote has passed. The holder itself never touches
 *   the HOME after its own deadline (withSeatLock hands it `pastDeadline`), so
 *   a live pid past it is a reused pid or a holder that has stopped acting.
 * A lock with no readable pid is abandoned only past SEAT_LOCK_EMPTY_GRACE_MS
 * (a holder still writing it).
 */
export const seatLockAbandoned = (content, mtimeMs, {
  now = Date.now, pidAlive = defaultPidAlive, graceMs = SEAT_LOCK_EMPTY_GRACE_MS,
} = {}) => {
  const [pidText, , deadlineText] = String(content).trim().split(/\s+/);
  const pid = Number.parseInt(pidText, 10);
  if (!(Number.isInteger(pid) && pid > 0)) return now() - mtimeMs > graceMs;
  let alive = true;
  try { alive = pidAlive(pid); } catch { alive = true; }
  if (!alive) return true;
  const deadline = Number.parseInt(deadlineText, 10);
  return Number.isInteger(deadline) && deadline > 0 && now() > deadline;
};

/**
 * Runs `fn({ pastDeadline })` holding the seat's turn lock, so two `agent run`
 * processes of one seat (the daemon's and a foreground one) never interleave
 * their HOME steps with each other's VM. The lock sits beside the HOME, in the
 * host-owned seats folder the guest never mounts, as `.<seat folder>.lock`,
 * reading `<pid> <token> <deadline>`. `holdMs` sets the deadline; the caller
 * checks `pastDeadline()` before every HOME step and stops touching the HOME
 * once it is true. A waiter reclaims the lock only as seatLockAbandoned says,
 * by the guarded re-check withFileLock makes, and past `waitMs` refuses with
 * `microvm_seat_busy`: it never runs unlocked.
 */
export const withSeatLock = (home, fn, {
  waitMs = SEAT_LOCK_WAIT_MS, holdMs = INSTALL_LOCK_MAX_MS, pollMs = 250, now = Date.now, pidAlive = defaultPidAlive,
  _remove,
} = {}) => {
  let deadline = 0;
  return withFileLock(dirname(home), `.${basename(home)}.lock`, () => fn({ pastDeadline: () => now() > deadline }), {
    waitMs,
    pollMs,
    now,
    pidAlive,
    ...(_remove ? { remove: _remove } : {}),
    suffix: () => {
      deadline = now() + holdMs;
      return ` ${deadline}`;
    },
    abandoned: (content, mtimeMs) => seatLockAbandoned(content, mtimeMs, { now, pidAlive }),
    busy: (lock) => Object.assign(new Error(`the microVM sandbox will not touch this seat's HOME: another turn `
      + `of this seat still holds ${lock}; try again when it ends`), { code: 'microvm_seat_busy' }),
  });
};

/** msb and the guest's agent (Claude unless named), ready to run a turn. */
export const prepareMicrovmHost = async ({
  log, root = microsandboxRoot(), agent = 'claude',
} = {}) => withInstallLock(root, async () => {
  const msb = await ensureMsb({ root });
  ensureGuestAgent({
    agent, msb, root, log,
  });
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
  ensureGuestAgent,
  ensureGuestClaude,
  ensureGuestCodex,
  ensureMsb,
  microvmFlagOn,
  probeWhp,
  writeMicrovmTurn,
};
