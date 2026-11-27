// A cli publish is not atomic: for a few minutes npm already names the new
// version as @latest while its tarball still 404s. A smoke that walks the
// page's `npx -y @commonlyai/cli@latest ...` line verbatim fails on that gap
// even though nothing it tests is wrong (F674). This gate runs before the walk:
// it resolves what @latest names, then fetches that exact tarball into npm's
// cache (which npx reads), retrying until npm serves it. The page's command
// is not touched. If npm never serves it, the walk runs as it always did, so a
// real outage still fails the job.
//
// The gate is bounded three ways so a hanging registry cannot eat the job: each
// npm call is cut off at CALL_TIMEOUT_MS, no try starts unless a whole try
// (a view and a fetch) still fits in the total, and the settings are capped so
// attempts x delay can never exceed that total.

import { spawnSync } from 'child_process';

export const DEFAULT_ATTEMPTS = 10;
export const DEFAULT_DELAY_SECONDS = 20;
export const DEFAULT_TOTAL_SECONDS = 240;
export const CALL_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 60;
const MAX_DELAY_SECONDS = 300;
const MIN_TOTAL_SECONDS = 60; // one try is two calls
const MAX_TOTAL_SECONDS = 600;
// A try is a view, then a fetch; each may run to its timeout.
const TRY_MS = 2 * CALL_TIMEOUT_MS;
// The whole line, so a warning, trailing text or a shell metacharacter never counts.
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

const wholeNumber = (name, raw, { min, max }) => {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  const value = Number(text);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
};

const settingOrDefault = (name, raw, fallback, bounds) => (
  raw === undefined || raw === '' ? fallback : wholeNumber(name, raw, bounds)
);

/** Reads the three env settings. Throws on anything that is not a whole number in range, or whose attempts x delay exceeds the total. */
export const npmWaitSettings = (env = process.env) => {
  const attempts = settingOrDefault('COMMONLY_BYO_NPM_WAIT_ATTEMPTS', env.COMMONLY_BYO_NPM_WAIT_ATTEMPTS,
    DEFAULT_ATTEMPTS, { min: 1, max: MAX_ATTEMPTS });
  const delaySeconds = settingOrDefault('COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS', env.COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS,
    DEFAULT_DELAY_SECONDS, { min: 0, max: MAX_DELAY_SECONDS });
  const totalSeconds = settingOrDefault('COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS', env.COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS,
    DEFAULT_TOTAL_SECONDS, { min: MIN_TOTAL_SECONDS, max: MAX_TOTAL_SECONDS });
  if (attempts * delaySeconds > totalSeconds) {
    throw new Error(`COMMONLY_BYO_NPM_WAIT_ATTEMPTS x COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS (${attempts} x ${delaySeconds}) exceeds COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS (${totalSeconds})`);
  }
  return { attempts, delaySeconds, totalSeconds };
};

// A caller may pass settings it built itself; hold them to the same limits.
const checkedSettings = ({ attempts, delaySeconds, totalSeconds }) => npmWaitSettings({
  COMMONLY_BYO_NPM_WAIT_ATTEMPTS: String(attempts),
  COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS: String(delaySeconds),
  COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS: String(totalSeconds),
});

/** The last line of `npm view ... version` output that is a version and nothing else. */
const versionFrom = (stdout) => String(stdout || '').split(/\r?\n/).map((l) => l.trim()).reverse()
  .find((l) => VERSION.test(l)) || null;

/**
 * Waits until npm serves the tarball of the version `<pkg>@latest` names.
 * `run(bin, args)` returns { status, stdout, stderr }, `sleep(ms)` waits and
 * `now()` is a clock in ms; all three are injected so a test needs neither npm
 * nor real time. Returns { served, version, tries }; it never throws for a
 * fetch that fails, only for a bad setting.
 */
export const waitForNpmServed = async ({
  pkg, run, sleep, now = Date.now, log = () => {}, settings = npmWaitSettings(), npmBin = 'npm',
}) => {
  const { attempts, delaySeconds, totalSeconds } = checkedSettings(settings);
  const totalMs = totalSeconds * 1000;
  const started = now();
  let version = null;
  let tries = 0;
  while (tries < attempts) {
    if (now() - started + TRY_MS > totalMs) {
      log(`npm wait: no time left for another try inside ${totalSeconds} s`);
      break;
    }
    tries += 1;
    const view = run(npmBin, ['view', `${pkg}@latest`, 'version']);
    let why;
    if (view.status !== 0) {
      version = null;
      why = 'npm view failed';
    } else {
      version = versionFrom(view.stdout);
      why = 'npm view named no version';
    }
    if (version) {
      const fetched = run(npmBin, ['cache', 'add', `${pkg}@${version}`]);
      if (fetched.status === 0) {
        log(`npm wait ${tries}/${attempts}: ${pkg}@${version} is served`);
        return { served: true, version, tries };
      }
      why = `fetching ${pkg}@${version} failed: ${String(fetched.stderr || '').split('\n').find((l) => /E\d{3}|404|ERR|error/i.test(l)) || `exit ${fetched.status}`}`;
    }
    const sleepMs = delaySeconds * 1000;
    // Sleep only when another whole try can still start after it.
    const more = tries < attempts && now() - started + sleepMs + TRY_MS <= totalMs;
    log(`npm wait ${tries}/${attempts}: ${why}${more ? `; retrying in ${delaySeconds} s` : ''}`);
    if (!more) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(sleepMs);
  }
  log(`npm wait: ${pkg}@latest was not served after ${tries} tries; walking anyway`);
  return { served: false, version, tries };
};

/**
 * The real command runner: npm on POSIX, npm.cmd on Windows (Node refuses to
 * spawn a .cmd file directly, so it goes through cmd.exe the way the other
 * Windows smokes run npm). Every argument is a fixed word or a checked version.
 * Each call is cut off at CALL_TIMEOUT_MS. If a Windows child holds the pipe the
 * cut-off may not return; the total deadline and the workflow step's own
 * timeout-minutes are what bound that case.
 */
export const npmBinFor = (platform = process.platform) => (platform === 'win32' ? 'npm.cmd' : 'npm');
export const runNpm = (bin, args) => {
  const options = { encoding: 'utf8', timeout: CALL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${bin} ${args.join(' ')}"`], { ...options, windowsVerbatimArguments: true })
    : spawnSync(bin, args, options);
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || String(result.error?.message || '') };
};
