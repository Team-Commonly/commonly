/**
 * "Your CLI is N versions behind" — one line at `agent run` and `daemon run`
 * start-up (TASK-660, D213).
 *
 * A seat pinned to an old CLI fails in ways that look like platform bugs, and
 * nothing on the seat said it was old. This prints one line when the installed
 * CLI trails npm latest by UPDATE_NOTICE_MIN_BEHIND or more, and is otherwise
 * silent: offline, a slow registry, a malformed answer and
 * COMMONLY_NO_UPDATE_CHECK=1 all print nothing.
 *
 * It must never slow start-up. `startUpdateNotice` returns at once; the lookup
 * runs beside the poll loop, is capped at UPDATE_TIMEOUT_MS by its own timer
 * (a fetch that ignores its abort signal still cannot hold it), and is cached
 * for UPDATE_CACHE_TTL_MS so a restarting seat asks the registry once a day.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { exactVersion, parseVersion } from './mcp-server-version.js';

export const CLI_PACKAGE = '@commonlyai/cli';
export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@commonlyai%2fcli/latest';
export const UPDATE_CHECK_OPT_OUT_ENV = 'COMMONLY_NO_UPDATE_CHECK';
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 2000;
// The CLI publishes often, so one or two releases behind is the normal gap
// between a publish and a seat's next restart. Three is where it is stale.
export const UPDATE_NOTICE_MIN_BEHIND = 3;

export const updateCachePath = (home = homedir()) => join(home, '.commonly', 'update-check.json');

/**
 * How far `installed` trails `latest`: 0 when equal or ahead, the patch gap
 * within one major.minor, and Infinity when latest is a newer minor or major
 * (the patch numbers of two release lines say nothing about the distance).
 * null when either side is not a version.
 */
export const versionsBehind = (installed, latest) => {
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  if (!a || !b) return null;
  if (a[0] !== b[0] || a[1] !== b[1]) {
    return (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1])) ? Infinity : 0;
  }
  return Math.max(0, b[2] - a[2]);
};

/** The one line to print, or null when there is nothing worth saying. */
export const updateNoticeLine = ({ installed, latest, minBehind = UPDATE_NOTICE_MIN_BEHIND }) => {
  const behind = versionsBehind(installed, latest);
  if (behind === null || behind < minBehind) return null;
  // Only the parsed triple is printed: the registry's string never reaches the log.
  const from = exactVersion(installed);
  const to = exactVersion(latest);
  const gap = Number.isFinite(behind) ? `${behind} versions behind` : 'behind a newer release line';
  return `your CLI is ${gap} (installed ${from}, latest ${to}). Update: npm install -g ${CLI_PACKAGE}@latest`
    + ` (silence with ${UPDATE_CHECK_OPT_OUT_ENV}=1)`;
};

const defaultReadText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const defaultWriteText = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
};

/** The cached latest version when the cache is younger than the TTL, else null. */
export const readCachedLatest = ({ cachePath, now, readText = defaultReadText, ttlMs = UPDATE_CACHE_TTL_MS }) => {
  let raw;
  try {
    raw = readText(cachePath);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const cache = JSON.parse(raw);
    const checkedAt = Date.parse(cache?.checkedAt);
    const latest = exactVersion(cache?.latest);
    if (!Number.isFinite(checkedAt) || !latest) return null;
    if (now - checkedAt < 0 || now - checkedAt >= ttlMs) return null;
    return latest;
  } catch {
    return null;
  }
};

/**
 * npm latest, or null on any failure. The timer is the cap, not the signal:
 * the signal asks fetch to stop, the race guarantees the answer is on time.
 */
export const fetchLatestVersion = async ({
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_TIMEOUT_MS,
  url = REGISTRY_LATEST_URL,
} = {}) => {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  const lookup = (async () => {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res?.ok) return null;
    const body = await res.json();
    return exactVersion(body?.version);
  })().catch(() => null);
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/** The notice line for this start-up, or null. Never throws. */
export const checkForCliUpdate = async ({
  installedVersion,
  env = process.env,
  now = Date.now(),
  cachePath = updateCachePath(),
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_TIMEOUT_MS,
  readText = defaultReadText,
  writeText = defaultWriteText,
  minBehind = UPDATE_NOTICE_MIN_BEHIND,
} = {}) => {
  try {
    if (env?.[UPDATE_CHECK_OPT_OUT_ENV] === '1') return null;
    if (!parseVersion(installedVersion)) return null;
    let latest = readCachedLatest({ cachePath, now, readText });
    if (!latest) {
      latest = await fetchLatestVersion({ fetchImpl, timeoutMs });
      if (!latest) return null;
      try {
        writeText(cachePath, `${JSON.stringify({ checkedAt: new Date(now).toISOString(), latest })}\n`);
      } catch {
        // An unwritable cache costs one lookup per start, nothing more.
      }
    }
    return updateNoticeLine({ installed: installedVersion, latest, minBehind });
  } catch {
    return null;
  }
};

/**
 * Fire the check and return at once. The returned promise (for tests) settles
 * to the line that was logged, or null.
 */
export const startUpdateNotice = ({ log, ...options }) => {
  const pending = checkForCliUpdate(options).then((line) => {
    if (line) {
      try {
        log(line);
      } catch {
        // A closed log sink must not surface as an unhandled rejection.
      }
    }
    return line;
  });
  return pending;
};

let cachedCliVersion;
/** This CLI's own version, from the package.json it shipped with. */
export const installedCliVersion = () => {
  if (cachedCliVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      cachedCliVersion = typeof pkg?.version === 'string' ? pkg.version : null;
    } catch {
      cachedCliVersion = null;
    }
  }
  return cachedCliVersion;
};
