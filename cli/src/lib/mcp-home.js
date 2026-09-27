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
 * The cold path is pinned too (TASK-174's second half). A spawn with no usable
 * home still runs the declaration, but not with the shared `@latest` spec: the
 * spec this spawn executes is the version the registry already answered with,
 * read from the warm's own cache, so `@latest`'s one shared npx dir is not on
 * the spawn path even once. The fallback is the declaration as written, and it
 * is used exactly when nothing has ever resolved a version on this host — a
 * fresh machine's first spawn, where `@latest` is also the only spec that could
 * work — or when the cache is unreadable. Nothing here throws.
 *
 * Every filesystem answer here is injected, because the two states that matter
 * (a home that has never been warmed, and a home whose pointed-at version dir was
 * deleted under it) cannot both be produced on one host.
 */
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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

/**
 * Version dirs kept after a successful advance.
 *
 * This is a DISK BOUND, not the safety rule. Retention by count cannot express
 * "not while someone is running it": keeping the newest three protects the
 * newest three, and a seat still executing the fourth-newest dir is exactly the
 * case that matters. A DIR IS REMOVABLE only when it is not `current`, carries
 * no LIVE liveness claim, and is past `PRUNE_GRACE_MS` (Vera, 74878/74887).
 */
export const KEEP_VERSION_DIRS = 3;

/**
 * A version dir younger than this is never pruned, even with no live claimant.
 *
 * Time, not count, is what bounds the exposure: a dir inside the window may
 * belong to a spawn that is starting up and has not written its claim yet, or
 * whose claim was written by a pid the kernel has since recycled.
 */
export const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Where a spawn records that a process may still be executing from a version. */
export const IN_USE_DIR_NAME = '.inuse';

/** The warm child's own exit codes, read by the spawn path's logs. */
export const WARM_RESULTS = Object.freeze({
  LOCKED: 'locked',
  CURRENT: 'current',
  ADVANCED: 'advanced',
  REGISTRY_UNAVAILABLE: 'registry-unavailable',
  INSTALL_FAILED: 'install-failed',
  PROBE_FAILED: 'probe-failed',
});

export const mcpHomeDir = (env = process.env) => {
  const configured = env && env[MCP_HOME_ENV];
  // A DEFECT THIS LITERALLY PREVENTED, 2026-09-27: `process.env.X = undefined`
  // does not unset X, it sets the STRING "undefined" (Node coerces env values),
  // so a caller that saved and restored an unset override handed the warm the
  // home `./undefined/` — which it created, populated and pointed at, inside the
  // package directory. This value is a PATH; a value that is not a plausible
  // path is not a home, and the real home is the safe answer.
  if (typeof configured === 'string' && configured && configured !== 'undefined' && configured !== 'null') {
    return configured;
  }
  return join(homedir(), '.commonly', 'mcp');
};

/** True for a home a warm may write into: a real, absolute-looking path. */
export const isUsableWarmHome = (home) => (
  typeof home === 'string'
  && home.length > 1
  && home !== 'undefined'
  && home !== 'null'
  && (home.startsWith('/') || /^[A-Za-z]:[\\/]/.test(home))
);

/** The home a caller asked for, or the configured one — never a junk string. */
export const resolveHomeDir = (home) => (isUsableWarmHome(home) ? home : mcpHomeDir());

export const currentPointerPath = (home) => join(home, 'current');
export const versionDirFor = (home, version) => join(home, version);
export const packageDirFor = (home, version) => join(home, version, 'node_modules', MCP_PACKAGE);
export const lockPathFor = (home) => join(home, WARM_LOCK_NAME);

/** `<home>/<version>/.inuse/` — one empty file per claiming pid. */
export const inUseDirFor = (home, version) => join(versionDirFor(home, version), IN_USE_DIR_NAME);
export const inUseMarkerPath = (home, version, pid) => join(inUseDirFor(home, version), String(pid));

/** A pid is a positive integer, or it is not a pid. */
const parsePid = (value) => {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Is this pid still running? `kill(pid, 0)` asks the kernel and sends nothing.
 *
 * EPERM means the pid exists and belongs to another user — alive. ESRCH means
 * gone — dead. Anything else, including a value that was never a pid, is DEAD,
 * because the two errors are not symmetric: guessing "alive" pins a version dir
 * forever (unbounded disk with extra steps), while guessing "dead" costs one
 * reinstall on a later warm.
 */
export const isPidAlive = (pid, { kill = process.kill } = {}) => {
  const parsed = parsePid(pid);
  if (parsed === null) return false;
  try {
    kill(parsed, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
};

/**
 * The claimants under a version dir that are still running.
 *
 * The marker's PRESENCE is not the signal — a seat that is killed or crashes
 * leaves its file behind, and a pruner that read presence would never remove
 * that version again. The check is whether the claimant still exists; a dead or
 * unparseable marker counts as absent.
 */
export const liveInUsePids = (home, version, {
  readDir = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  isAlive = isPidAlive,
} = {}) => readDir(inUseDirFor(home, version))
  .map(parsePid)
  .filter((pid) => pid !== null && isAlive(pid));

/**
 * Claim a version dir for a process that may be executing from it.
 *
 * Called by `prepareMcpSpawn`, keyed by THIS process: the MCP server runs as a
 * descendant of the process that materialised the command, so while that process
 * lives its version dir must not be pruned. A claim that cannot be written is
 * reported, never swallowed: `prepareMcpSpawn` refuses to exec from a dir it
 * could not claim (Vera 74903), because an unclaimed dir is one the pruner is
 * free to `rm -rf` while this seat is running out of it.
 */
export const claimInUse = ({
  home,
  version,
  pid = process.pid,
  mkdir = mkdirSync,
  writeFile = writeFileSync,
} = {}) => {
  try {
    if (!isUsableWarmHome(home) || !parseVersion(version) || parsePid(pid) === null) {
      return { claimed: false, reason: 'not_claimable' };
    }
    mkdir(inUseDirFor(home, version), { recursive: true });
    writeFile(inUseMarkerPath(home, version, pid), '');
    return { claimed: true, reason: null };
  } catch (error) {
    // The errno is the difference between a home nobody can write to and a
    // `.inuse` path that is a file, and only one of those is worth a log line
    // that says which.
    return { claimed: false, reason: (error && error.code) || 'claim_failed' };
  }
};

/**
 * Say it out loud. A seat whose claim failed is still a seat, but it must not be
 * a silent one: warn() is injectable so a test can hold the sentence.
 */
const defaultWarn = (line) => {
  try {
    process.stderr.write(`${line}\n`);
  } catch { /* a seat that cannot warn still runs */ }
};

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
  // `join` resolves `..`, so this is the whole confinement. The package is our
  // own published build and today `bin` cannot escape — but a check that costs
  // one line makes the exec path self-evident instead of trusted (Vera, 74880).
  if (!binPath.startsWith(`${pkgDir}${sep}`)) return null;
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
 * The shipped command with its spec pinned to `version`, or the command
 * unchanged when there is no version to pin to.
 *
 * Only slot 2 is touched, and only after `isShippedCommonlyMcpCommand` has
 * proven the slot is the package spec — so `npx`, its `-y` and every other
 * entry survive byte-for-byte, and a command that is not the shipped 3-arg form
 * cannot be rewritten by construction. npx keys its cache dir by the spec
 * string, which is the whole point: `@latest` is one dir every seat shares and a
 * publish rewrites in place, while `@0.3.13` is a dir only this version ever
 * uses.
 */
export const pinShippedSpec = (command, version) => {
  if (!Array.isArray(command) || !parseVersion(version)) return command;
  let changed = false;
  const pinned = command.map((part, index) => {
    if (index !== 2 || !isUnpinnedShippedSpec(String(part))) return part;
    changed = true;
    return `${MCP_PACKAGE}@${version}`;
  });
  // The same reference when nothing changed, so a caller can use identity as the
  // "did this spawn's spec move" check — the convention the rest of this module
  // already keeps (`ensureCommonlyMcpServer`, `withholdGrantBroker`).
  return changed ? pinned : command;
};

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
  home,
  readFile = defaultRead,
  exists = defaultExists,
  readBin = (h, v) => readBinPath(h, v, { readFile, exists }),
  newest = (h) => newestInstalledVersion(h, { readBin }),
} = {}) => {
  const target = resolveHomeDir(home);
  if (!isShippedCommonlyMcpCommand(command) || !isUnpinnedShippedSpec(String(command[2]))) {
    return { command, source: 'declared', version: null, reason: 'not-the-shipped-unpinned-spec' };
  }
  const pointer = readCurrentVersion(target, { readFile });
  if (pointer) {
    const bin = readBin(target, pointer);
    if (bin) return { command: ['node', bin], source: 'home', version: pointer, reason: 'pointer' };
  }
  const fallback = newest(target);
  if (fallback) {
    const bin = readBin(target, fallback);
    if (bin) {
      return {
        command: ['node', bin],
        source: 'home',
        version: fallback,
        reason: pointer ? 'pointer-bin-missing' : 'no-pointer',
      };
    }
  }
  // No usable home, so the declaration is what runs — and the one thing worth
  // changing about it is the spec string. The cached registry answer is used
  // rather than a fresh lookup because this function is synchronous and on the
  // spawn's critical path, and the warm refreshes that same cache on the same
  // TTL (`REGISTRY_TTL_MS`). A stale-but-real version still gives this run its
  // own npx dir, which `@latest` does not, and a stale cache means the registry
  // has been answering nothing for a while — the case where `@latest` is least
  // usable. `pinned` is reported so the caller can log which spec it ran.
  const cached = readRegistryCache(target, { readFile });
  const pinned = cached ? pinShippedSpec(command, cached.version) : command;
  return {
    command: pinned,
    source: 'declared',
    version: null,
    reason: 'home-empty',
    pinned: cached ? cached.version : null,
  };
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
  home,
  apiUrl = null,
  spawnImpl = spawn,
  childPath = warmChildPath(),
} = {}) => {
  try {
    // argv entries are coerced with String(), so an undefined home reaches the
    // child as the literal 'undefined' and it warms a directory by that name.
    const targetHome = resolveHomeDir(home);
    const child = spawnImpl(process.execPath, [childPath, targetHome], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        COMMONLY_MCP_HOME: targetHome,
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
  home,
  apiUrl = null,
  spawnImpl,
  childPath,
  now = Date.now(),
  readFile = defaultRead,
  exists = defaultExists,
  warn = defaultWarn,
} = {}) => {
  const resolvedHome = resolveHomeDir(home);
  try {
    const plan = planMcpSpawn(command, { home: resolvedHome, readFile, exists });
    // Claim the version this spawn is about to execute from, BEFORE returning the
    // command, so a prune that runs while the seat is starting cannot take it.
    let resolved = plan.command;
    if (plan.source === 'home') {
      const claim = claimInUse({ home: resolvedHome, version: plan.version });
      // A claim that could not be written means the pruner may take this very
      // directory out from under the running seat — the hazard the claim exists
      // for. The declared command is what the guard approved and what no pruner
      // owns, so the spawn falls back to it rather than executing unprotected,
      // and says why. The warm still runs: with the seat off the dir, a prune or
      // a repair is safe.
      if (!claim.claimed) {
        warn(`commonly: cannot claim ${versionDirFor(resolvedHome, plan.version)} for pid ${process.pid} (${claim.reason}) — running the declared command instead, because a prune could delete the directory this seat would run from`);
        resolved = command;
      }
    }
    const due = !lockPresent(resolvedHome, { exists })
      && warmLooksWanted(resolvedHome, plan.version, { now, readFile });
    if (due) kickWarm({ home: resolvedHome, apiUrl, spawnImpl, childPath });
    return resolved;
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
