/**
 * F637: a Windows install piled up ~140 copies of `commonly daemon run` on one
 * machine key, and the daemon routes' limiters answered each with a 429 the
 * daemon retried in a second or two. Two server-side pieces reach CLIs that
 * predate the single-instance lock:
 *
 * - The 429 on the two routes a daemon polls (the heartbeat and
 *   GET /api/agent-binding/assigned) carries an `error` field. Old CLIs print
 *   `body.error` before `body.message`, so the daemon log says what is wrong
 *   and how to fix it.
 * - Registration refuses a Windows CLI older than DAEMON_MIN_CLI_VERSION_WIN32,
 *   once that is set (unset by default, so nothing changes until a fixed CLI
 *   has shipped).
 */

export const DUPLICATE_DAEMON_429_ERROR = "rate limit exceeded on this computer's daemon key: "
  + 'more than one Commonly daemon may be running. Update the CLI, then reinstall the daemon: '
  + 'npx @commonlyai/cli@latest daemon setup';

export const WIN32_CLI_TOO_OLD_MESSAGE = 'This CLI version can start duplicate daemons on Windows. '
  + 'Update it, then set the daemon up again: npx @commonlyai/cli@latest daemon setup';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

const versionParts = (value: unknown): number[] | null => {
  if (typeof value !== 'string') return null;
  const match = VERSION.exec(value.trim());
  return match ? match.slice(1, 4).map(Number) : null;
};

/**
 * True when `version` is lower than `minimum`, compared numerically per part
 * (0.1.99 < 0.1.391 < 0.1.1000). A missing or malformed `version` counts as
 * lower. A prerelease suffix is ignored.
 */
export const cliVersionBelow = (version: unknown, minimum: string): boolean => {
  const min = versionParts(minimum);
  if (!min) return false;
  const have = versionParts(version);
  if (!have) return true;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== min[i]) return have[i] < min[i];
  }
  return false;
};

/**
 * The refusal message for a registration's host report, or null to allow it.
 * Only a report that says win32 is judged; one with no platform is allowed,
 * since an older CLI may send no host at all.
 */
export const win32RegistrationRefusal = (
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const minimum = String(env.DAEMON_MIN_CLI_VERSION_WIN32 || '').trim();
  if (!minimum || !versionParts(minimum)) return null;
  if (!host || typeof host !== 'object' || Array.isArray(host)) return null;
  const { platform, cliVersion } = host as { platform?: unknown; cliVersion?: unknown };
  if (platform !== 'win32') return null;
  return cliVersionBelow(cliVersion, minimum) ? WIN32_CLI_TOO_OLD_MESSAGE : null;
};
