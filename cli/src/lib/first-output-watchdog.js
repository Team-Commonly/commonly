/**
 * First-output watchdog for a seat's model CLI spawn.
 *
 * On 2026-10-30 every launchd seat's `claude -p` turn parked while the Mac's
 * console was locked: no transcript row, no stdout, no stderr, for the full
 * 45-minute run timeout. Each one held its delivery the whole time, the retry
 * respawned it into the same hang, and the log said only "claude timed out
 * after 2700000ms", which names nothing.
 *
 * The signal is not stdout. A seat runs `claude -p --output-format text`,
 * which writes stdout once, at the end, so a healthy 20-minute turn has zero
 * stdout bytes for 20 minutes. What a healthy turn does write is its session
 * transcript: measured on the dart seat, the first row landed 0.7 s after the
 * spawn, and the hung spawns that night wrote no row at all. So a spawn counts
 * as started when it writes any stdout or stderr byte OR its transcript grows.
 * A spawn that does neither inside the window is killed with a reason.
 */
import { statSync } from 'fs';

export const DEFAULT_FIRST_OUTPUT_WINDOW_MS = 180_000;

// 0 turns the watchdog off; anything unparseable keeps the default.
export const firstOutputWindowMs = (env = process.env) => {
  const raw = env?.COMMONLY_FIRST_OUTPUT_WINDOW_MS;
  if (raw === undefined || raw === '') return DEFAULT_FIRST_OUTPUT_WINDOW_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FIRST_OUTPUT_WINDOW_MS;
};

export const SPAWN_STALLED_CODE = 'spawn_stalled';

// The message carries the class word spawn-retry.js matches, so the stall gets
// its own backoff rather than RUNTIME's 5-second retry.
export const spawnStalledError = ({ label, windowMs, reason }) => {
  const error = new Error(
    `${label} produced no output in ${Math.round(windowMs / 1000)}s (${reason}); killed before the run timeout`,
  );
  error.code = SPAWN_STALLED_CODE;
  error.stallReason = reason;
  return error;
};

// `ioreg -n Root -d1` prints `"IOConsoleLocked" = Yes` while the screen is
// locked. True, false, or null when it cannot tell (not darwin, ioreg failed).
// child_process is loaded on demand: suites that mock it with only `spawn`
// would otherwise fail to import every adapter that uses this module.
export const consoleLocked = async ({ platform = process.platform, execFileImpl } = {}) => {
  if (platform !== 'darwin') return null;
  const run = execFileImpl || (await import('child_process')).execFile;
  if (typeof run !== 'function') return null;
  return new Promise((resolve) => {
    run('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = String(stdout).match(/"IOConsoleLocked"\s*=\s*(Yes|No)/);
      return resolve(match ? match[1] === 'Yes' : null);
    });
  });
};

const sizeOf = (file) => {
  if (!file) return -1;
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
};

/**
 * Watch `proc` for its first sign of life. Returns `{ stop }`; call it when the
 * process closes. `onStall(reason)` fires at most once, after the caller should
 * kill the process.
 */
export const watchFirstOutput = ({
  proc,
  windowMs,
  transcriptPath = null,
  onStall,
  lockProbe = consoleLocked,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) => {
  if (!windowMs) return { stop: () => {} };
  let started = false;
  let stopped = false;
  const markStarted = () => { started = true; };
  proc.stdout?.on('data', markStarted);
  proc.stderr?.on('data', markStarted);
  // A missing file counts as empty, so creating an empty one is not growth.
  const baseline = Math.max(0, sizeOf(transcriptPath));
  const timer = setTimeoutImpl(async () => {
    if (started || sizeOf(transcriptPath) > baseline) return;
    const locked = await lockProbe().catch(() => null);
    if (stopped) return;
    onStall(locked ? 'console locked' : 'no transcript, stdout or stderr');
  }, windowMs);
  timer?.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeoutImpl(timer);
    },
  };
};
