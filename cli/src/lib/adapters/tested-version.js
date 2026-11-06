// A namespace import, read at call time: suites that mock child_process with
// only spawn/spawnSync still load this module.
import * as childProcess from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveOnPath } from '../resolve-on-path.js';

// Public seats run only on a harness version smoke-tested in its sandbox, with
// one tolerance: a stable patch release after the newest tested one, on that
// same major.minor line. Harnesses ship patches every few days, and refusing
// them refused every new BYO user on the current npm release (D245, 11-04).
// A newer minor or major, an older patch, an older line, or a prerelease still
// refuses until it is smoke-tested and added to the adapter's list.
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

export const isPatchAfterNewestTested = (version, tested) => {
  const installed = STABLE.exec(String(version || ''));
  const newest = STABLE.exec(String(tested[tested.length - 1] || ''));
  if (!installed || !newest) return false;
  return Number(installed[1]) === Number(newest[1])
    && Number(installed[2]) === Number(newest[2])
    && Number(installed[3]) > Number(newest[3]);
};

// A floor rather than a list: the version, or anything later, prereleases of a
// later version included, so the list's prerelease rule above doesn't apply. A
// prerelease of the floor comes before it, and an unreadable version meets nothing.
export const meetsMinimumVersion = (version, minimum) => {
  const installed = SEMVER.exec(String(version ?? ''));
  const floor = STABLE.exec(String(minimum ?? ''));
  if (!installed || !floor) return false;
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(installed[part]) - Number(floor[part]);
    if (difference !== 0) return difference > 0;
  }
  return !installed[4];
};

export const PUBLIC_CODEX_VERSION_CODE = 'public_codex_version';

// `found` stays in this message, which only the seat's log shows. The line a pod
// sees is built from `requiredVersion` (turn-failure-notice.js).
export const publicCodexVersionError = ({ found, required }) => {
  const error = new Error(found
    ? `public seat refused this turn: Codex ${found} is older than this seat needs. `
      + `Upgrade Codex to at least ${required} and start the agent again.`
    : 'public seat refused this turn: could not read the Codex version. '
      + `Check that \`codex --version\` works for this agent, upgrade Codex to at least ${required} `
      + 'if it is older, and start the agent again.');
  error.code = PUBLIC_CODEX_VERSION_CODE;
  error.requiredVersion = required;
  return error;
};

// The harness's own `--version`, asked without blocking the event loop and
// remembered per binary. A daemon runs every seat in one process, beside the
// loopback provider proxies of other seats' live turns, so a synchronous probe
// stalled all of them while a cold harness started (up to its timeout).
//
// The cache key is the binary's real path; its mtime decides freshness, so a
// harness upgraded in place is probed again. Only a parsed version is kept: a
// failed or unparseable probe is asked again next turn, never remembered.
//
// A bare name ('goose', 'qwen') is resolved through the probe env's PATH, as
// execFile would resolve it, never against the daemon's working directory: a
// cwd lookup missed the cache every turn and could key it on a same-named file
// there. What runs is that resolved real path, so the binary that answers is
// the one the key names. A name that does not resolve runs as given, uncached.
//
// `args` come before `--version`, for a launch that is an interpreter and a
// script (a Windows npm shim). The interpreter's path says nothing about which
// script it would run, so that probe is never cached.
const versionCache = new Map();

const resolveBinary = (binary, env) => {
  const name = String(binary || '');
  if (!name) return null;
  const located = basename(name) === name ? resolveOnPath(name, env?.PATH) : name;
  if (!located) return null;
  try {
    const key = realpathSync(located);
    return { key, mtimeMs: statSync(key).mtimeMs };
  } catch {
    return null;
  }
};

export const probeVersion = async (binary, {
  args = [], env, timeoutMs = 30000, parse, execFileImpl = childProcess.execFile, cache = versionCache,
} = {}) => {
  const resolved = args.length ? null : resolveBinary(binary, env);
  const key = resolved?.key || null;
  const hit = key ? cache.get(key) : null;
  if (hit && hit.mtimeMs === resolved.mtimeMs) return hit.version;
  const stdout = await new Promise((resolve) => {
    execFileImpl(key || binary, [...args, '--version'], { encoding: 'utf8', env, timeout: timeoutMs }, (error, out) => {
      resolve(error ? null : out);
    });
  });
  const version = stdout === null ? null : parse(stdout);
  if (version && key) cache.set(key, { mtimeMs: resolved.mtimeMs, version });
  return version;
};
