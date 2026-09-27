/**
 * Where a seat's `@commonlyai/mcp` is executed FROM.
 *
 * Why this exists (TASK-174). Every seat's default declaration is
 * `npx -y @commonlyai/mcp@latest` (default-environment.js), and npx names its
 * cache dir by the hash of the SPEC STRING — npm 11.12.1,
 * libnpmexec/lib/index.js:238-250, sha512(spec)[0:16]. So
 * sha512('@commonlyai/mcp@latest')[0:16] = 6d82e98be466b586 is ONE dir shared by
 * every seat, rewritten in place when the first spawn after a publish sees a new
 * version, and every npx run does registry + lock work before the server is even
 * started. Two failures were measured on 2026-09-27: seats lost the server for
 * minutes after the 0.3.13 publish at 10:47:57Z (the in-place rebuild), and Vera
 * got a 30 s CONNECT_TIMEOUT with no publish at all (the shared dir's mtime
 * moves on every npx run, so a slow registry round-trip alone exceeds the
 * client's connect budget).
 *
 * The fix takes npx OFF the spawn path. A spawn executes
 * `node <home>/<version>/node_modules/@commonlyai/mcp/<bin>` for the version a
 * pointer file names; versions are installed by EXACT spec into their own
 * version dir by a background single-flight warm (mcp-warm-child.mjs), and the
 * pointer moves only after the new bin answers MCP `initialize`.
 *
 * The DECLARATION is not touched. `declared-mcp-guard.isShippedCommonlyMcpEntry`
 * still audits `npx -y @commonlyai/mcp@latest` verbatim (TASK-150) — that guard
 * judges what an operator declared, and this module only changes what a spawn
 * executes. A declaration that PINS a version is never rewritten: that is the
 * operator saying which build to run, and the npx cache already gives a pinned
 * spec its own dir.
 *
 * Every filesystem answer here is injected, because the two states that matter
 * (a home that has never been warmed, and a home whose pointed-at version dir was
 * deleted under it) cannot both be produced on one host.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isShippedCommonlyMcpCommand } from './declared-mcp-guard.js';
import { MCP_PACKAGE, parseVersion } from './mcp-server-version.js';

/** The env override, so tests (and an operator) can point the home elsewhere. */
export const MCP_HOME_ENV = 'COMMONLY_MCP_HOME';

export const WARM_LOCK_NAME = '.warm.lock';
export const REGISTRY_CACHE_NAME = '.registry.json';

/** How long a cached registry answer is trusted before the warm re-checks. */
export const REGISTRY_TTL_MS = 15 * 60 * 1000;

/** A lock older than this is a warm that died; reclaim rather than wedge. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/** Version dirs kept after a successful advance (the current one always survives). */
export const KEEP_VERSION_DIRS = 3;

/** The warm child's own exit codes, read by the spawn path's logs. */
export const WARM_RESULTS = Object.freeze({
  LOCKED: 'locked',
  CURRENT: 'current',
  ADVANCED: 'advanced',
  REGISTRY_UNAVAILABLE: 'registry-unavailable',
  INSTALL_FAILED: 'install-failed',
  PROBE_FAILED: 'probe-failed',
});

export const mcpHomeDir = (env = process.env) => (
  (env && typeof env[MCP_HOME_ENV] === 'string' && env[MCP_HOME_ENV])
    ? env[MCP_HOME_ENV]
    : join(homedir(), '.commonly', 'mcp')
);

export const currentPointerPath = (home) => join(home, 'current');
export const versionDirFor = (home, version) => join(home, version);
export const packageDirFor = (home, version) => join(home, version, 'node_modules', MCP_PACKAGE);
export const lockPathFor = (home) => join(home, WARM_LOCK_NAME);

const defaultRead = (path) => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
};

const defaultExists = (path) => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

/**
 * The version the pointer file names, or null.
 *
 * A pointer that does not parse is treated as no pointer at all: a spawn must
 * never build a path out of a string it did not validate, and the fallback is
 * the declared command, not a guess.
 */
export const readCurrentVersion = (home, { readFile = defaultRead } = {}) => {
  const raw = readFile(currentPointerPath(home));
  if (typeof raw !== 'string') return null;
  const version = raw.trim();
  return parseVersion(version) ? version : null;
};

/**
 * The bin a package.json beside a script names, resolved — never guessed.
 *
 * `bin` is `{ 'commonly-mcp': 'src/index.js' }` at 0.3.13 and a bare string in
 * older releases, so both shapes are read. A dir whose bin is missing on disk is
 * not a build this seat can run: returning null there is what sends a spawn back
 * to the declared command instead of exec'ing a path that does not exist.
 */
const readBinInPackageDir = (pkgDir, {
  readFile = defaultRead, exists = defaultExists,
} = {}) => {
  const raw = readFile(join(pkgDir, 'package.json'));
  if (typeof raw !== 'string') return null;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== 'object') return null;
  // A package.json naming another package settles it: this dir is not ours.
  if (pkg.name !== undefined && pkg.name !== MCP_PACKAGE) return null;
  const bin = pkg.bin;
  let relative = null;
  if (typeof bin === 'string' && bin) {
    relative = bin;
  } else if (bin && typeof bin === 'object') {
    const keys = Object.keys(bin).filter((k) => typeof bin[k] === 'string' && bin[k]);
    if (keys.length === 1) [relative] = keys.map((k) => bin[k]);
    else if (typeof bin['commonly-mcp'] === 'string' && bin['commonly-mcp']) relative = bin['commonly-mcp'];
  }
  if (!relative) return null;
  const binPath = join(pkgDir, relative);
  return exists(binPath) ? binPath : null;
};

/** The bin of a version dir inside the seat's home. */
export const readBinPath = (home, version, options = {}) => {
  if (!parseVersion(version)) return null;
  return readBinInPackageDir(packageDirFor(home, version), options);
};

/**
 * The bin of an npm PREFIX dir, which is the shape the warm installs into:
 * `npm install --prefix <dir>` leaves `<dir>/node_modules/...`, with no version
 * component in the path. Reading the two shapes with one function would mean
 * looking for a version dir inside the temp prefix and concluding the install
 * failed when it did not.
 */
export const readBinInPrefix = (prefix, options = {}) => (
  readBinInPackageDir(join(prefix, 'node_modules', MCP_PACKAGE), options)
);

/**
 * The newest version dir in the home that actually has a runnable bin.
 *
 * The pointer is only written after a verified warm, so it is normally the whole
 * answer. This is the recovery path for the case the pointer cannot cover: the
 * pointed-at version dir deleted under a live seat (hand-pruned, a wiped home,
 * npm falling back to a reinstall). Falling back to the next-newest local build
 * keeps the spawn off npx even then, which is the whole point of the change.
 */
export const newestInstalledVersion = (home, {
  readDir = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readBin = (h, v) => readBinPath(h, v),
} = {}) => {
  const versions = readDir(home)
    .filter((name) => parseVersion(name))
    .filter((name) => readBin(home, name))
    .sort((a, b) => {
      const [am, an, ap] = parseVersion(a);
      const [bm, bn, bp] = parseVersion(b);
      return (am - bm) || (an - bn) || (ap - bp);
    });
  return versions.length ? versions[versions.length - 1] : null;
};

/** True for the shipped, UNPINNED spec — the only command shape this rewrites. */
const isUnpinnedShippedSpec = (spec) => (
  spec === MCP_PACKAGE || spec === `${MCP_PACKAGE}@latest`
);

/**
 * What a spawn should execute, and where that decision came from.
 *
 * `source: 'home'` — the command is `node <bin>` from the version dir, no npx
 * and no network. `source: 'declared'` — the declaration runs as written, which
 * is either an operator's pinned spec or an EMPTY HOME (fresh host, or a home
 * that was deleted). The empty-home path is the old failure mode and it is
 * accepted, written down, and once per empty home rather than once per publish.
 * `reason` names which of those it was, for the spawn path's logs.
 */
export const planMcpSpawn = (command, {
  home = mcpHomeDir(),
  readFile = defaultRead,
  exists = defaultExists,
  readBin = (h, v) => readBinPath(h, v, { readFile, exists }),
  newest = (h) => newestInstalledVersion(h, { readBin }),
} = {}) => {
  if (!isShippedCommonlyMcpCommand(command) || !isUnpinnedShippedSpec(String(command[2]))) {
    return { command, source: 'declared', version: null, reason: 'not-the-shipped-unpinned-spec' };
  }
  const pointer = readCurrentVersion(home, { readFile });
  if (pointer) {
    const bin = readBin(home, pointer);
    if (bin) return { command: ['node', bin], source: 'home', version: pointer, reason: 'pointer' };
  }
  const fallback = newest(home);
  if (fallback) {
    const bin = readBin(home, fallback);
    if (bin) {
      return {
        command: ['node', bin],
        source: 'home',
        version: fallback,
        reason: pointer ? 'pointer-bin-missing' : 'no-pointer',
      };
    }
  }
  return { command, source: 'declared', version: null, reason: 'home-empty' };
};

/** The warm's cached registry answer, with its age. */
export const readRegistryCache = (home, { readFile = defaultRead } = {}) => {
  const raw = readFile(join(home, REGISTRY_CACHE_NAME));
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    const version = parsed && typeof parsed.version === 'string' ? parsed.version : null;
    const checkedAt = parsed && Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : null;
    if (!parseVersion(version) || checkedAt === null) return null;
    return { version, checkedAt };
  } catch {
    return null;
  }
};

/** True when the cached "latest" is newer than what this spawn is about to run. */
export const warmLooksWanted = (home, version, { now = Date.now(), readFile = defaultRead } = {}) => {
  const cached = readRegistryCache(home, { readFile });
  if (!cached) return true;
  if (now - cached.checkedAt > REGISTRY_TTL_MS) return true;
  if (!version) return true;
  const target = parseVersion(cached.version);
  const running = parseVersion(version);
  if (!target || !running) return true;
  return (target[0] > running[0])
    || (target[0] === running[0] && target[1] > running[1])
    || (target[0] === running[0] && target[1] === running[1] && target[2] > running[2]);
};

export const warmChildPath = () => join(dirname(fileURLToPath(import.meta.url)), 'mcp-warm-child.mjs');

/**
 * Start the warm and walk away. Detached + unref'd, so a seat that spawns and
 * exits does not wait on it, and the child is written to never throw at the
 * parent: a warm that fails costs the NEXT spawn nothing but the old version.
 */
export const kickWarm = ({
  home = mcpHomeDir(),
  apiUrl = null,
  spawnImpl = spawn,
  childPath = warmChildPath(),
} = {}) => {
  try {
    const child = spawnImpl(process.execPath, [childPath, home], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...(apiUrl ? { COMMONLY_WARM_API_URL: String(apiUrl) } : {}),
      },
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
};

const lockPresent = (home, { exists = defaultExists } = {}) => exists(lockPathFor(home));

/**
 * The one entry the adapters call: what to execute, plus a warm if one is due.
 *
 * Sync and network-free by construction — the registry check, the install and
 * the probe all live in the child. A lock already held means another spawn is
 * warming, so this spawn just runs the current version.
 */
export const prepareMcpSpawn = (command, {
  home = mcpHomeDir(),
  apiUrl = null,
  spawnImpl,
  childPath,
  now = Date.now(),
  readFile = defaultRead,
  exists = defaultExists,
} = {}) => {
  try {
    const plan = planMcpSpawn(command, { home, readFile, exists });
    const due = !lockPresent(home, { exists }) && warmLooksWanted(home, plan.version, { now, readFile });
    if (due) kickWarm({ home, apiUrl, spawnImpl, childPath });
    return plan.command;
  } catch {
    // A rewrite that throws must not cost the seat its tools: the declaration
    // is what the guard approved, and it still runs.
    return command;
  }
};

/** Kept for callers that want the plan and the command in one call. */
export const resolveMcpSpawnCommand = prepareMcpSpawn;

export const statOrNull = (path) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};
