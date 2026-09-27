/**
 * The background warm for the seat MCP home — see mcp-home.js for why.
 *
 * This runs as a DETACHED child, never on a spawn path, because everything it
 * does is slow or networked: a registry lookup, an `npm install`, and an MCP
 * `initialize` handshake against the freshly installed bin. The spawn path only
 * reads a pointer file and exec's `node <bin>`.
 *
 * Order of operations is the contract: install into `.tmp-<version>-<pid>`,
 * PROBE the bin inside that temp dir, and only then `rename` it into
 * `<home>/<version>` and move the pointer. So a version dir in the home is a
 * version that answered the protocol at least once, and a half-installed or
 * non-starting build can never become what seats execute.
 *
 * Single-flight by lock file (O_EXCL), so concurrent spawns on a fresh host
 * trigger exactly one install. A lock older than STALE_LOCK_MS is a warm that
 * died (a laptop sleeping mid-install is the normal way) and is reclaimed rather
 * than allowed to wedge the home forever.
 *
 * The probe's env is measured, not assumed: at 0.3.13 the bin exits 1 with
 * "[commonly-mcp] fatal: COMMONLY_API_URL is required" and, with that set, exits
 * 1 again on "No runtime token". With both present as PLACEHOLDERS it answers
 * `initialize` with a result — the boot check is presence-only and `initialize`
 * does not touch the network (both measured on this host 2026-09-27), which is
 * what makes a credential-free probe honest rather than a stub.
 */
import { spawn as spawnChild } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  KEEP_VERSION_DIRS, REGISTRY_CACHE_NAME, REGISTRY_TTL_MS, STALE_LOCK_MS, WARM_RESULTS,
  currentPointerPath, isUsableWarmHome, lockPathFor, readBinInPrefix, versionDirFor,
} from './mcp-home.js';
import { MCP_PACKAGE, parseVersion } from './mcp-server-version.js';

export const PROBE_API_URL_PLACEHOLDER = 'http://127.0.0.1:1';
export const PROBE_TOKEN_PLACEHOLDER = 'cm_agent_warm_probe';
export const PROBE_TIMEOUT_MS = 10 * 1000;
export const REGISTRY_TIMEOUT_MS = 20 * 1000;

const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'commonly-cli-warm', version: '1' },
  },
});

const exists = (path) => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

const readIfAny = (path) => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
};

/**
 * Take the warm lock, reclaiming one that is too old to belong to a live warm.
 *
 * Returns the open fd, or null when another process holds a fresh lock.
 */
export const acquireWarmLock = (home, {
  now = Date.now(),
  open = (path) => openSync(path, 'wx'),
  stat = (path) => statSync(path),
  remove = (path) => unlinkSync(path),
  staleMs = STALE_LOCK_MS,
} = {}) => {
  const lockPath = lockPathFor(home);
  try {
    return open(lockPath);
  } catch (error) {
    if (error && error.code !== 'EEXIST') return null;
  }
  let age;
  try {
    age = now - stat(lockPath).mtimeMs;
  } catch {
    return null; // vanished between EEXIST and stat: not ours to break
  }
  if (age <= staleMs) return null;
  try {
    remove(lockPath);
  } catch {
    return null;
  }
  try {
    return open(lockPath);
  } catch {
    // Lost the reclaim race to another spawn's warm. Fine: that one is working.
    return null;
  }
};

/** Default `npm` runner. Resolves `{ ok, stdout }`; never rejects. */
export const runCommand = (bin, args, { timeout = REGISTRY_TIMEOUT_MS } = {}) => new Promise((resolve) => {
  let settled = false;
  let child;
  const done = (result) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  try {
    child = spawnChild(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  } catch (error) {
    done({ ok: false, stdout: '', stderr: String(error && error.message) });
    return;
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
    done({ ok: false, stdout, stderr: `${stderr}\n[commonly] timed out after ${timeout}ms` });
  }, timeout);
  child.on('error', (error) => { clearTimeout(timer); done({ ok: false, stdout, stderr: String(error && error.message) }); });
  child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, code, stdout, stderr }); });
});

/** The registry's current version for the package, cached on disk with a TTL. */
export const resolveRegistryLatest = async (home, {
  now = Date.now(),
  exec = runCommand,
  ttlMs = REGISTRY_TTL_MS,
  writeFile = (path, text) => writeFileSync(path, text),
} = {}) => {
  const cachePath = join(home, REGISTRY_CACHE_NAME);
  const cached = readIfAny(cachePath);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Number.isFinite(parsed.checkedAt) && now - parsed.checkedAt < ttlMs
        && parseVersion(parsed.version)) {
        return { version: parsed.version, source: 'cache' };
      }
    } catch { /* unreadable cache is just a miss */ }
  }
  const result = await exec('npm', ['view', MCP_PACKAGE, 'version', '--json'], { timeout: REGISTRY_TIMEOUT_MS });
  const raw = result && result.ok ? String(result.stdout || '').trim() : '';
  let version = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      version = typeof parsed === 'string' ? parsed : null;
    } catch {
      version = raw.replace(/^"|"$/g, '');
    }
  }
  if (version && parseVersion(version)) {
    try {
      writeFile(cachePath, JSON.stringify({ version, checkedAt: now }));
    } catch { /* a cache we cannot write is not a warm we should fail */ }
    return { version, source: 'registry' };
  }
  // Registry down: the last known answer is better than none, and better than
  // moving the pointer backwards.
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parseVersion(parsed.version)) return { version: parsed.version, source: 'stale-cache' };
    } catch { /* fall through */ }
  }
  return { version: null, source: 'unavailable' };
};

/**
 * Does the installed bin start and speak the protocol?
 *
 * Accepts a JSON-RPC response to id 1 whether it is a `result` or an `error`:
 * what this proves is that the build runs and answers `initialize`, which is
 * exactly what the pointer's contract claims. It is not an authorization check —
 * the seat's own token is what makes calls work.
 */
export const probeBin = (binPath, {
  spawnImpl = spawnChild,
  timeoutMs = PROBE_TIMEOUT_MS,
  apiUrl = process.env.COMMONLY_WARM_API_URL || PROBE_API_URL_PLACEHOLDER,
} = {}) => new Promise((resolve) => {
  let settled = false;
  let child;
  const done = (ok) => {
    if (settled) return;
    settled = true;
    try {
      if (child) child.kill('SIGKILL');
    } catch { /* already gone */ }
    resolve(ok);
  };
  try {
    child = spawnImpl(process.execPath, [binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COMMONLY_API_URL: String(apiUrl),
        COMMONLY_AGENT_TOKEN: PROBE_TOKEN_PLACEHOLDER,
      },
    });
  } catch {
    resolve(false);
    return;
  }
  const timer = setTimeout(() => done(false), timeoutMs);
  let seen = '';
  const onData = (chunk) => {
    seen += String(chunk);
    if (/"id"\s*:\s*1/.test(seen)) {
      clearTimeout(timer);
      done(true);
    }
  };
  child.stdout.on('data', onData);
  child.on('error', () => { clearTimeout(timer); done(false); });
  child.on('close', () => { clearTimeout(timer); done(false); });
  try {
    child.stdin.write(`${INITIALIZE_REQUEST}\n`);
  } catch {
    clearTimeout(timer);
    done(false);
  }
});

const writePointerAtomic = (home, version, { writeTemp = writeFileSync } = {}) => {
  const target = currentPointerPath(home);
  const temp = join(home, `.current-${process.pid}`);
  writeTemp(temp, `${version}\n`);
  renameSync(temp, target);
};

/** Keep the newest N version dirs; the current one is never a candidate. */
export const pruneVersionDirs = (home, current, {
  keep = KEEP_VERSION_DIRS,
  readDir = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  remove = (path) => rmSync(path, { recursive: true, force: true }),
} = {}) => {
  const versions = readDir(home).filter((name) => parseVersion(name));
  versions.sort((a, b) => {
    const [am, an, ap] = parseVersion(a);
    const [bm, bn, bp] = parseVersion(b);
    return (bm - am) || (bn - an) || (bp - ap);
  });
  const removed = [];
  versions.slice(keep).forEach((name) => {
    if (name === current) return;
    try {
      remove(versionDirFor(home, name));
      removed.push(name);
    } catch { /* a dir we cannot remove is not a failed warm */ }
  });
  return removed;
};

/**
 * The whole warm, in one function so a test can drive every branch with injected
 * I/O. Returns one of WARM_RESULTS — never throws, because it runs unattended.
 */
export const warmMcpHome = async (home, {
  now = Date.now(),
  exec = runCommand,
  probe = probeBin,
  spawnProbe,
  lock = () => acquireWarmLock(home, { now }),
  closeLock = (fd) => closeSync(fd),
  mkdir = (dir) => mkdirSync(dir, { recursive: true }),
  remove = (path) => rmSync(path, { recursive: true, force: true }),
  rename = (from, to) => renameSync(from, to),
  readBin = (prefix) => readBinInPrefix(prefix),
  readCurrent = (h) => {
    const raw = readIfAny(currentPointerPath(h));
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return parseVersion(trimmed) ? trimmed : null;
  },
  keep = KEEP_VERSION_DIRS,
} = {}) => {
  mkdir(home);
  const fd = lock();
  if (fd === null) return WARM_RESULTS.LOCKED;
  try {
    const latest = await resolveRegistryLatest(home, { now, exec });
    if (!latest.version) return WARM_RESULTS.REGISTRY_UNAVAILABLE;
    const target = latest.version;
    const current = readCurrent(home);
    if (current && current === target) return WARM_RESULTS.CURRENT;
    if (current && parseVersion(current) && parseVersion(target)) {
      const [tm, tn, tp] = parseVersion(target);
      const [cm, cn, cp] = parseVersion(current);
      if ((tm < cm) || (tm === cm && tn < cn) || (tm === cm && tn === cn && tp <= cp)) {
        return WARM_RESULTS.CURRENT;
      }
    }
    const temp = join(home, `.tmp-${target}-${process.pid}`);
    remove(temp);
    mkdir(temp);
    const install = await exec('npm', [
      'install', '--prefix', temp, `${MCP_PACKAGE}@${target}`, '--no-save', '--no-audit', '--no-fund',
    ], { timeout: 5 * 60 * 1000 });
    if (!install || !install.ok) {
      remove(temp);
      return WARM_RESULTS.INSTALL_FAILED;
    }
    const bin = readBin(temp);
    if (!bin) {
      remove(temp);
      return WARM_RESULTS.INSTALL_FAILED;
    }
    const started = await (spawnProbe || probe)(bin, { apiUrl: process.env.COMMONLY_WARM_API_URL });
    if (!started) {
      remove(temp);
      return WARM_RESULTS.PROBE_FAILED;
    }
    const destination = versionDirFor(home, target);
    if (exists(destination)) remove(temp);
    else rename(temp, destination);
    writePointerAtomic(home, target);
    pruneVersionDirs(home, target, { keep });
    return WARM_RESULTS.ADVANCED;
  } catch {
    return WARM_RESULTS.INSTALL_FAILED;
  } finally {
    try {
      closeLock(fd);
    } catch { /* nothing to close */ }
    try {
      rmSync(lockPathFor(home), { force: true });
    } catch { /* lock is best-effort cleanup */ }
  }
};

const invokedDirectly = process.argv[1] && /mcp-warm-child\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  // Validated, not trusted: argv entries are coerced with String(), so a parent
  // that passed an undefined home sends the literal 'undefined' and this child
  // would otherwise create and populate a directory by that name (which is how
  // one appeared inside the package directory on 2026-09-27).
  const home = process.argv[2];
  if (isUsableWarmHome(home)) {
    warmMcpHome(home, { now: Date.now() })
      .then((result) => {
        // A warm runs with stdio ignored; this is for a human running it by hand
        // and for `--verbose` debugging, and it must never be on a spawn path.
        if (process.env.COMMONLY_WARM_VERBOSE) process.stdout.write(`${result}\n`);
        process.exitCode = 0;
      })
      .catch(() => { process.exitCode = 0; });
  }
}
