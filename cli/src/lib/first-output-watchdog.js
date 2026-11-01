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
 * A spawn that does neither inside the window is killed with a reason. When
 * the transcript is missing altogether, the path may simply be wrong, so the
 * spawn is killed only if the console is also locked.
 *
 * That is the rule for a plain-text spawn. A stream-json spawn (TASK-710) counts
 * only model events on stdout; see `modelStream` on watchFirstOutput.
 */
import { realpathSync, statSync } from 'fs';
import { readProcess } from '@commonlyai/seats/process-group';

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

// Claude names its project folder after process.cwd(), which on macOS is the
// physical path (/tmp is /private/tmp), so the transcript is looked for there.
export const physicalPath = (dir) => {
  if (!dir) return dir;
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

// How long a stalled spawn gets to exit after SIGTERM before SIGKILL.
export const STALL_KILL_GRACE_MS = 10_000;

/**
 * SIGKILL each snapshotted descendant of a stalled spawn that is still alive
 * once the spawn itself has exited. Its parent may have exited, so it may now
 * belong to launchd: only the pid and start time are matched, which still
 * rules out a reused pid. Returns the pids signalled.
 */
export const killStallSurvivors = (snapshot, { read = readProcess, kill = process.kill.bind(process) } = {}) => {
  const killed = [];
  for (const row of snapshot || []) {
    const now = read(row.pid);
    if (!now || now.started !== row.started) continue;
    try { kill(row.pid, 'SIGKILL'); killed.push(row.pid); } catch { /* gone */ }
  }
  return killed;
};

const sizeOf = (file) => {
  if (!file) return -1;
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
};

// A stream-json line is model progress when it is an event other than `system`.
// The `system` events are `init` (written before any model call) and
// `api_retry` (a provider failing and retrying). Counting either would keep a
// hung provider looking alive until the run timeout.
export const isModelProgressLine = (line) => {
  try {
    const event = JSON.parse(line);
    return !!event && typeof event === 'object' && event.type !== 'system';
  } catch {
    return false;
  }
};

/**
 * Watch `proc` for its first sign of life. Returns `{ stop }`; call it when the
 * process closes. `onStall(reason)` fires at most once, after the caller should
 * kill the process.
 *
 * With `modelStream`, the spawn writes stream-json events. Only model output
 * counts as life there. A transcript row does not, because claude writes its
 * first row about a second after spawn, before any model reply. Stderr does
 * not either: claude prints warnings at spawn (an unrecognised model, a
 * connector notice) whatever the provider does next.
 */
export const watchFirstOutput = ({
  proc,
  windowMs,
  transcriptPath = null,
  modelStream = false,
  onStall,
  lockProbe = consoleLocked,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) => {
  if (!windowMs) return { stop: () => {} };
  let started = false;
  let stopped = false;
  let partial = '';
  const markStarted = () => { started = true; };
  if (modelStream) {
    proc.stdout?.on('data', (chunk) => {
      const lines = (partial + chunk.toString()).split('\n');
      partial = lines.pop();
      if (lines.some(isModelProgressLine)) markStarted();
    });
  } else {
    proc.stdout?.on('data', markStarted);
    proc.stderr?.on('data', markStarted);
  }
  // A missing file counts as empty, so creating an empty one is not growth.
  const baseline = Math.max(0, sizeOf(transcriptPath));
  const timer = setTimeoutImpl(async () => {
    const size = sizeOf(transcriptPath);
    if (started || (!modelStream && size > baseline)) return;
    const locked = await lockProbe().catch(() => null);
    // Output can arrive while the probe runs (ps or ioreg may take a second).
    if (stopped || started) return;
    if (modelStream) {
      // The model signal does not read the transcript, so a missing path cannot
      // hide a hung provider here.
      onStall(locked ? 'console locked' : 'stuck: no model output inside the window');
      return;
    }
    // No transcript where one was expected may only mean the path is wrong, so
    // that alone never kills a turn: it takes a locked console as well.
    if (size < 0 && locked !== true) return;
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
