import { promises as fsPromises } from 'fs';
import inspector from 'inspector';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { describeError } from '../utils/safeErrorLog';

/**
 * Keeps a CPU profile of each event-loop stall, behind LOOP_STALL_PROFILE=1
 * (F681).
 *
 * `[loop-lag]` logs stalls of 1–4 s at times nobody can predict, and the
 * signal profiler (cpuProfileOnSignal.ts) runs only when an operator times a
 * SIGUSR2. So this one profiles all the time, at a coarse 10 ms sampling
 * interval, in rolling windows of LOOP_STALL_PROFILE_WINDOW_S seconds. At each
 * window end its own loop-delay sampler (createLoopDelaySampler) says whether
 * the window stalled, read at once with no wait. A stall writes that window's
 * profile and the one before it, so a stall that began before the boundary is
 * still covered; a quiet window is discarded,
 * except that it is held as the next window's "previous". It stops by itself
 * after LOOP_STALL_PROFILE_MAX_SAVES stalls or LOOP_STALL_PROFILE_HOURS, and
 * any session or write error logs once and stops it (a failed prune only
 * logs). Runbook: docs/runbooks/cpu-profile-on-signal.md.
 *
 * It runs alongside the signal profiler: each inspector session gets its own
 * V8 CpuProfiler with its own sampling interval, so two sessions that both
 * call Profiler.start each get a complete profile (checked by hand on Node 22
 * and 26).
 *
 * Off by default, and when off it creates no session, sampler or timer.
 */

export const SAMPLING_INTERVAL_US = 10_000;
// The loop-delay sampler's tick period.
export const LOOP_DELAY_INTERVAL_MS = 20;
// Each Profiler.start pauses the loop for roughly 50–150 ms while V8 re-logs
// compiled code, so the longest window means the fewest pauses.
export const DEFAULT_WINDOW_S = 60;
export const DEFAULT_THRESHOLD_MS = 1000;
export const DEFAULT_MAX_SAVES = 3;
export const DEFAULT_HOURS = 24;
export const KEEP_FILES = 6;
// Separate from the signal profiler's `cpu-*`, so neither prunes the other.
const FILE_PATTERN = /^stall-.*\.cpuprofile$/;

interface ProfilerSession {
  connect(): void;
  disconnect(): void;
  post(method: string, callback: (err: Error | null, result?: unknown) => void): void;
  post(method: string, params: object, callback: (err: Error | null, result?: unknown) => void): void;
}

interface ProfileFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink(file: string): Promise<void>;
}

interface Logger {
  log(format: string, ...args: unknown[]): void;
  error(format: string, ...args: unknown[]): void;
}

export interface LoopDelayMonitor {
  start(): void;
  stop(): void;
  /** Starts a new window: forgets the worst delay and re-baselines to now. */
  reset(): void;
  /** Worst loop delay this window, in ms, including the tick in progress. */
  readMaxMs(): number;
}

/**
 * Our own loop-delay sampler, in place of monitorEventLoopDelay. An unref'd
 * interval records `now - last - interval` on each tick, the time its tick
 * ran late. Two things the histogram can't do (F681):
 *
 * - readMaxMs also counts the interval still in progress, so a block that
 *   ended just before the read, with no tick since, is seen without waiting.
 *   Every block was then either recorded by a tick or lies in that interval.
 *   The histogram only counted a delay at its next sample, and no fixed wait
 *   makes that sample come before the read in every order.
 * - reset re-baselines `last` to now instead of zeroing it. The histogram's
 *   reset zeroed its previous-sample time, which discarded the delay in
 *   progress and made its first sample after a reset a baseline only, so a
 *   block right after a reset was lost too. Here a block just before reset
 *   is dropped (what we want for our own profiler pause) and a block just
 *   after it is counted at the next tick or read.
 */
export const createLoopDelaySampler = (intervalMs: number = LOOP_DELAY_INTERVAL_MS): LoopDelayMonitor => {
  let last = performance.now();
  let windowMaxMs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer) return;
      last = performance.now();
      windowMaxMs = 0;
      timer = setInterval(() => {
        const now = performance.now();
        windowMaxMs = Math.max(windowMaxMs, now - last - intervalMs);
        last = now;
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    reset() {
      windowMaxMs = 0;
      last = performance.now();
    },
    readMaxMs() {
      return Math.max(0, windowMaxMs, performance.now() - last - intervalMs);
    },
  };
};

export interface LoopStallProfilerHandle {
  stop(): void;
}

const parseClamped = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export const parseWindowSeconds = (raw: string | undefined): number => parseClamped(raw, DEFAULT_WINDOW_S, 10, 60);
export const parseThresholdMs = (raw: string | undefined): number =>
  parseClamped(raw, DEFAULT_THRESHOLD_MS, 100, 60_000);

const post = (session: ProfilerSession, method: string, params?: object): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const done = (err: Error | null, result?: unknown) => (err ? reject(err) : resolve(result));
    if (params) session.post(method, params, done);
    else session.post(method, done);
  });

export const startLoopStallProfiler = ({
  env = process.env,
  createSession = () => new inspector.Session() as unknown as ProfilerSession,
  createDelayMonitor = () => createLoopDelaySampler(),
  fs = fsPromises as unknown as ProfileFs,
  logger = console as Logger,
}: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createSession?: () => ProfilerSession;
  createDelayMonitor?: () => LoopDelayMonitor;
  fs?: ProfileFs;
  logger?: Logger;
} = {}): LoopStallProfilerHandle => {
  if (env.LOOP_STALL_PROFILE !== '1') return { stop: () => {} };

  const windowS = parseWindowSeconds(env.LOOP_STALL_PROFILE_WINDOW_S);
  const thresholdMs = parseThresholdMs(env.LOOP_STALL_PROFILE_THRESHOLD_MS);
  const maxSaves = parseClamped(env.LOOP_STALL_PROFILE_MAX_SAVES, DEFAULT_MAX_SAVES, 1, 20);
  const hours = parseClamped(env.LOOP_STALL_PROFILE_HOURS, DEFAULT_HOURS, 1, 168);
  const dir = env.LOOP_STALL_PROFILE_DIR || path.join(os.tmpdir(), 'cpuprofiles');
  const deadline = Date.now() + hours * 3_600_000;

  let session: ProfilerSession | null = null;
  let monitor: LoopDelayMonitor | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let previous: unknown = null;
  let saves = 0;
  let stopped = false;

  const shutdown = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    previous = null;
    try {
      monitor?.stop();
    } catch {
      // Already stopped.
    }
    monitor = null;
    const s = session;
    session = null;
    try {
      // Disconnecting also ends a running profile.
      s?.disconnect();
    } catch {
      // Already disconnected.
    }
  };

  const fail = (err: unknown) => {
    if (stopped) return;
    shutdown();
    try {
      logger.error('%s', '[loop-stall-profile] failed, profiler stopped', describeError(err));
    } catch {
      // A broken logger must not turn a failure into a throw.
    }
  };

  const schedule = () => {
    timer = setTimeout(() => {
      timer = null;
      rotate().catch(fail);
    }, windowS * 1000);
    // A pending window never holds the process open at shutdown.
    timer.unref?.();
  };

  const prune = async () => {
    const names = (await fs.readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort();
    // ISO timestamps sort by name, so the oldest come first.
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_FILES))) {
      await fs.unlink(path.join(dir, name));
    }
  };

  const save = async (prev: unknown, cur: unknown, maxMs: number) => {
    // Colons in a file name trip `docker cp <container>:<path>` and Windows.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const entries: Array<[string, unknown]> = [];
    if (prev) entries.push([path.join(dir, `stall-${stamp}-prev.cpuprofile`), prev]);
    entries.push([path.join(dir, `stall-${stamp}-cur.cpuprofile`), cur]);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, profile] of entries) {
      await fs.writeFile(file, JSON.stringify(profile));
    }
    logger.log('[loop-stall-profile] saved %s max=%dms', entries.map(([file]) => file).join(' '), Math.round(maxMs));
    try {
      await prune();
    } catch (err) {
      // Files already saved; a failed cleanup is no reason to stop profiling.
      try {
        logger.error('%s', '[loop-stall-profile] pruning old profiles failed', describeError(err));
      } catch {
        // A broken logger must not turn a failure into a throw.
      }
    }
  };

  const rotate = async () => {
    const s = session;
    const m = monitor;
    if (stopped || !s || !m) return;
    // No wait first: the read includes the interval in progress, so a block
    // that ended just before this timer ran is already counted.
    const maxMs = m.readMaxMs();
    // An in-process session answers synchronously; awaiting it only adds a
    // microtask, so no timer runs between here and the reset below.
    const { profile } = (await post(s, 'Profiler.stop')) as { profile: unknown };
    if (stopped) return;
    // Reset in the same tick as stop, so the stop pause isn't counted in the
    // next window. Moved after a timer yield, the profiler would spend its
    // saves on its own overhead.
    m.reset();

    const stalled = maxMs >= thresholdMs;
    const prev = previous;
    previous = stalled ? null : profile;
    if (stalled) saves += 1;

    let reason: string | null = null;
    if (saves >= maxSaves) reason = 'saves';
    else if (Date.now() >= deadline) reason = 'hours';

    // Start the next window before writing, so the write isn't a blind spot.
    if (!reason) {
      await post(s, 'Profiler.start');
      if (stopped) return;
      // Reset again, still in the same tick: the reset above came before the
      // 50–150 ms Profiler.start pause, and re-baselining after it keeps that
      // pause out of the new window too. Nothing else ran in between, so
      // nothing real is dropped. (The read above came before both pauses, so
      // neither is in the old window.)
      m.reset();
      schedule();
    }

    if (stalled) await save(prev, profile, maxMs);

    if (reason) {
      shutdown();
      if (reason === 'saves') logger.log('[loop-stall-profile] stopped: saved %d stalls, the limit', saves);
      else logger.log('[loop-stall-profile] stopped: ran %dh, the limit', hours);
    }
  };

  const begin = async () => {
    const s = createSession();
    session = s;
    s.connect();
    await post(s, 'Profiler.enable');
    // The interval can only be changed while this session is not profiling.
    await post(s, 'Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    await post(s, 'Profiler.start');
    if (stopped) return;
    // Started after Profiler.start, so its pause isn't counted either.
    monitor = createDelayMonitor();
    monitor.start();
    schedule();
    logger.log(
      '[loop-stall-profile] started, window=%ds threshold=%dms, writing stalls to %s',
      windowS,
      thresholdMs,
      dir,
    );
  };

  begin().catch(fail);

  return { stop: shutdown };
};

export default {
  startLoopStallProfiler,
  parseWindowSeconds,
  parseThresholdMs,
  SAMPLING_INTERVAL_US,
  LOOP_DELAY_INTERVAL_MS,
  createLoopDelaySampler,
};
// CJS compat: let require() return the module object with named exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
