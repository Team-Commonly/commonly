/**
 * `commonly doctor` — the checks (TASK-660, D213).
 *
 * D213 keeps the Node daemon and hardens install by making breakage visible.
 * Each check here answers one question a broken seat used to leave to a log
 * autopsy, prints one line (pass, fail or skip) and, when it fails, the command
 * that fixes it. Every outside fact (PATH, the saved login, the server, the
 * daemon record, the adapters, the macOS files) comes in through `deps`, so the
 * tests fake the environment and never touch this host.
 *
 * What a check must never do: print a token, or touch the keychain. The macOS
 * check only stats the login keychain file and `/usr/bin/security`; it never
 * runs `security`, so it cannot prompt, unlock or read a secret.
 */
import { delimiter, join } from 'node:path';
import { parseVersion, versionOlderThan } from './mcp-server-version.js';

export const PASS = 'pass';
export const FAIL = 'fail';
export const SKIP = 'skip';

const result = (id, status, detail, fix = null) => ({ id, status, detail, ...(fix ? { fix } : {}) });

/** `>=20`, `>=20.1` or `>=20.1.2` as a triple; null for any other range shape. */
export const enginesFloor = (range) => {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(range || ''));
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
};

// (a) Node against the package's engines floor.
export const checkNode = ({ nodeVersion, enginesRange }) => {
  const floor = enginesFloor(enginesRange);
  if (!floor) return result('node', SKIP, `Node ${nodeVersion}; engines range '${enginesRange || 'none'}' is not a >= floor`);
  const version = parseVersion(nodeVersion);
  if (!version) return result('node', FAIL, `could not read the Node version '${nodeVersion}'`, `install Node ${enginesRange}`);
  if (versionOlderThan(version, floor)) {
    return result('node', FAIL, `Node ${nodeVersion} is older than the CLI needs (${enginesRange})`, `install Node ${floor[0]} or newer`);
  }
  return result('node', PASS, `Node ${nodeVersion} (needs ${enginesRange})`);
};

/** Every `commonly` on PATH, first one first (the one a shell runs). */
export const findOnPath = ({ command, pathValue, platform, isExecutable }) => {
  // npm also drops a bare sh shim beside the .cmd on Windows; cmd.exe cannot run
  // it, so counting it would report a second install that is not one.
  const names = platform === 'win32' ? [`${command}.cmd`, `${command}.exe`] : [command];
  const found = [];
  for (const dir of String(pathValue || '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
};

// (b) Which `commonly` a shell runs, and its version.
export const checkInstall = ({
  pathValue, platform, isExecutable, runVersion, runningVersion,
}) => {
  const fix = 'npm install -g @commonlyai/cli';
  const found = findOnPath({ command: 'commonly', pathValue, platform, isExecutable });
  if (!found.length) return result('install', FAIL, 'no `commonly` on PATH', fix);
  const [binary] = found;
  const version = runVersion(binary);
  if (!parseVersion(version)) return result('install', FAIL, `${binary} did not answer --version`, `reinstall: ${fix}`);
  const notes = [];
  if (runningVersion && parseVersion(runningVersion) && version !== runningVersion) {
    notes.push(`this doctor is ${runningVersion}`);
  }
  if (found.length > 1) notes.push(`${found.length - 1} more on PATH`);
  return result('install', PASS, `commonly ${version} at ${binary}${notes.length ? ` (${notes.join('; ')})` : ''}`);
};

// (c) The instance every other command would use, and whose token it sends.
// The token is sent, never shown. `target` comes from loginTarget (commands/
// doctor.js), which resolves it the way createClient does, COMMONLY_TOKEN first.
export const checkLogin = async ({ target, fetchUser }) => {
  const where = target.key ? `${target.key} (${target.url})` : target.url;
  if (!target.tokenSource) {
    return result('login', FAIL, target.key ? `${where} has no saved token` : 'not logged in', target.loginHint);
  }
  const fromEnv = target.tokenSource === 'env';
  const tokenName = fromEnv ? 'the token in COMMONLY_TOKEN' : 'the saved token';
  const refix = fromEnv ? 'replace or unset COMMONLY_TOKEN' : target.loginHint;
  let user;
  try {
    user = await fetchUser();
  } catch (error) {
    if ([401, 403].includes(error?.status)) {
      return result('login', FAIL, `${where} rejected ${tokenName}`, refix);
    }
    return result('login', FAIL, `could not reach ${target.url}: ${error?.message || error}`, 'check the network, then re-run commonly doctor');
  }
  const who = user?.username || user?.email || user?._id;
  if (!who) return result('login', FAIL, `${where} answered without a user`, refix);
  return result('login', PASS, `@${who} on ${where}${fromEnv ? ' (token from COMMONLY_TOKEN)' : ''}`);
};

const ago = (iso, now) => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 120) return `${seconds}s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

// (d) The daemon: registered, service installed, heard from lately.
export const checkDaemon = async ({
  loadRecord, serviceFile, fileExists, fetchMachine, describeError, now,
}) => {
  let record;
  try {
    record = loadRecord();
  } catch (error) {
    return result('daemon', FAIL, error?.message || String(error), 'fix the file permissions named above, then re-run');
  }
  if (!record) {
    return result('daemon', SKIP, 'no daemon registered on this computer (optional; agents then run in the foreground)');
  }
  const name = record.machineName || 'this computer';
  if (!fileExists(serviceFile)) {
    return result('daemon', FAIL, `${name} is registered but its login service is not installed (${serviceFile})`, 'commonly daemon install');
  }
  let machine;
  try {
    machine = await fetchMachine(record);
  } catch (error) {
    return result('daemon', FAIL, describeError(error), 'commonly daemon status');
  }
  const heard = `last heartbeat ${ago(machine?.lastSeenAt, now)}`;
  if (machine?.status !== 'online') {
    return result('daemon', FAIL, `${machine?.name || name} is ${machine?.status || 'unknown'}, ${heard}`, 'commonly daemon restart, then commonly daemon logs');
  }
  return result('daemon', PASS, `${machine.name || name} online, service installed, ${heard}`);
};

const MAX_NAMED_AGENTS = 5;

// (e) Every adapter CLI a configured agent uses, found and answering --version.
export const checkAdapters = async ({ agents, getAdapter }) => {
  const byAdapter = new Map();
  for (const agent of agents) {
    const adapter = agent?.adapter || '?';
    if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
    byAdapter.get(adapter).push(agent.name);
  }
  if (!byAdapter.size) return [result('adapters', SKIP, 'no agents are attached on this computer')];
  const results = [];
  for (const [name, agentNames] of [...byAdapter.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const id = `adapter:${name}`;
    const sorted = agentNames.sort();
    const shown = sorted.slice(0, MAX_NAMED_AGENTS).join(', ');
    const used = `used by ${shown}${sorted.length > MAX_NAMED_AGENTS ? ` and ${sorted.length - MAX_NAMED_AGENTS} more` : ''}`;
    if (name === '?') {
      results.push(result(id, FAIL, `no adapter recorded in the token file, ${used}`, 'commonly agent detach <name> --force, then attach it again'));
      continue;
    }
    const adapter = getAdapter(name);
    if (!adapter) {
      results.push(result(id, FAIL, `unknown adapter '${name}', ${used}`, `commonly agent detach <name> --force, then attach it again`));
      continue;
    }
    if (typeof adapter.detect !== 'function') {
      results.push(result(id, SKIP, `${name} runs no local CLI, ${used}`));
      continue;
    }
    let found = null;
    let detectError = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      found = await adapter.detect();
    } catch (error) {
      detectError = error?.message || String(error);
    }
    if (detectError) {
      results.push(result(id, FAIL, `${name} could not be checked (${detectError}), ${used}`, `run the ${name} CLI with --version by hand`));
      continue;
    }
    if (!found) {
      results.push(result(id, FAIL, `${name} is not on PATH or its --version failed, ${used}`, `install the ${name} CLI, or put it on PATH`));
      continue;
    }
    const at = found.path ? ` at ${found.path}` : '';
    results.push(result(id, PASS, `${name} ${found.version || 'unknown version'}${at}, ${used}`));
  }
  return results;
};

// (f) macOS: what the claude adapter's confined spawn needs, by file stat only.
export const checkMacClaude = ({
  platform, agents, detectSeatbelt, isFile, loginKeychainPath, securityPath = '/usr/bin/security',
}) => {
  if (platform !== 'darwin') return result('macos-claude', SKIP, 'not macOS');
  if (!agents.some((agent) => agent?.adapter === 'claude')) {
    return result('macos-claude', SKIP, 'no agent here uses the claude adapter');
  }
  const missing = [];
  let seatbelt;
  try {
    seatbelt = detectSeatbelt();
  } catch (error) {
    seatbelt = { available: false, error: error?.message || String(error) };
  }
  if (!seatbelt?.available) missing.push(`Seatbelt (${seatbelt?.error || 'sandbox-exec unavailable'})`);
  if (!isFile(loginKeychainPath)) missing.push(`login keychain (${loginKeychainPath})`);
  if (!isFile(securityPath)) missing.push(`${securityPath}`);
  if (missing.length) {
    // A failed preflight most often means doctor itself is inside a sandbox
    // (an agent's turn), where a nested sandbox-exec is refused.
    const fixes = [];
    if (!seatbelt?.available) fixes.push('run commonly doctor from a normal Terminal, not from inside an agent\'s sandbox');
    if (missing.length > (seatbelt?.available ? 0 : 1)) {
      fixes.push('sign in to this Mac as the user the agent runs as, and run claude once to log in');
    }
    const fix = fixes.join('; ');
    return result('macos-claude', FAIL, `missing: ${missing.join('; ')}`, fix);
  }
  return result('macos-claude', PASS, 'Seatbelt runs, the login keychain and /usr/bin/security are present');
};

/** Every check, in the order the lines print. */
export const runDoctor = async (deps) => {
  // An unreadable tokens dir is one fail line, not a doctor that prints nothing.
  let agents = null;
  let listError = null;
  try {
    agents = deps.listAgents();
  } catch (error) {
    listError = error?.message || String(error);
  }
  return [
    checkNode(deps.node),
    checkInstall(deps.install),
    await checkLogin(deps.login),
    await checkDaemon(deps.daemon),
    ...(listError
      ? [
        result('adapters', FAIL, `could not list the attached agents (${listError})`, 'check that ~/.commonly/tokens is a directory you can read'),
        result('macos-claude', SKIP, 'the attached agents could not be listed'),
      ]
      : [
        ...(await checkAdapters({ agents, getAdapter: deps.getAdapter })),
        checkMacClaude({ ...deps.macos, agents }),
      ]),
  ];
};

// One line each, whatever a server or a CLI put in its error text.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const oneLine = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

export const formatDoctorLine = ({ id, status, detail, fix }) => (
  `${status.padEnd(4)}  ${id.padEnd(16)} ${oneLine(detail)}${status === FAIL && fix ? ` — fix: ${oneLine(fix)}` : ''}`
);

export const doctorExitCode = (results) => (results.some((r) => r.status === FAIL) ? 1 : 0);
