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

export const isPatchAfterNewestTested = (version, tested) => {
  const installed = STABLE.exec(String(version || ''));
  const newest = STABLE.exec(String(tested[tested.length - 1] || ''));
  if (!installed || !newest) return false;
  return Number(installed[1]) === Number(newest[1])
    && Number(installed[2]) === Number(newest[2])
    && Number(installed[3]) > Number(newest[3]);
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
  env, timeoutMs = 30000, parse, execFileImpl = childProcess.execFile, cache = versionCache,
} = {}) => {
  const resolved = resolveBinary(binary, env);
  const key = resolved?.key || null;
  const hit = key ? cache.get(key) : null;
  if (hit && hit.mtimeMs === resolved.mtimeMs) return hit.version;
  const stdout = await new Promise((resolve) => {
    execFileImpl(key || binary, ['--version'], { encoding: 'utf8', env, timeout: timeoutMs }, (error, out) => {
      resolve(error ? null : out);
    });
  });
  const version = stdout === null ? null : parse(stdout);
  if (version && key) cache.set(key, { mtimeMs: resolved.mtimeMs, version });
  return version;
};
