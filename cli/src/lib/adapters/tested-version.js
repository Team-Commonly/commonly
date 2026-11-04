// A namespace import, read at call time: suites that mock child_process with
// only spawn/spawnSync still load this module.
import * as childProcess from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';

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
const versionCache = new Map();

export const probeVersion = async (binary, {
  env, timeoutMs = 30000, parse, execFileImpl = childProcess.execFile, cache = versionCache,
} = {}) => {
  let key = null;
  let mtimeMs = null;
  try {
    key = realpathSync(binary);
    mtimeMs = statSync(key).mtimeMs;
  } catch {
    key = null;
  }
  const hit = key ? cache.get(key) : null;
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  const stdout = await new Promise((resolve) => {
    execFileImpl(binary, ['--version'], { encoding: 'utf8', env, timeout: timeoutMs }, (error, out) => {
      resolve(error ? null : out);
    });
  });
  const version = stdout === null ? null : parse(stdout);
  if (version && key) cache.set(key, { mtimeMs, version });
  return version;
};
