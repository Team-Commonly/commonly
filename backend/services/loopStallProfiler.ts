import { promises as fsPromises } from 'fs';
import inspector from 'inspector';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { describeError } from '../utils/safeErrorLog';

/**
 * Keeps a CPU profile of each event-loop stall, behind LOOP_STALL_PROFILE=1
 * (F681).
 *
 * `[loop-lag]` logs stalls of 1–4 s at times nobody can predict, and the
 * signal profiler (cpuProfileOnSignal.ts) runs only when an operator times a
 * SIGUSR2. So this one profiles all the time, at a coarse 10 ms sampling
 * interval, in rolling windows of LOOP_STALL_PROFILE_WINDOW_S seconds. At each
 * window end its own loop-delay histogram says whether the window stalled. A
 * stall writes that window's profile and the one before it, so a stall that
 * began before the boundary is still covered; a quiet window is discarded,
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
 * Off by default, and when off it creates no session, histogram or timer.
 */

export const SAMPLING_INTERVAL_US = 10_000;
// Each Profiler.start pauses the loop for roughly 50–150 ms while V8 re-logs
// compiled code, so the longest window means the fewest pauses.
export const DEFAULT_WINDOW_S = 60;
export const DEFAULT_THRESHOLD_MS = 1000;
export const DEFAULT_MAX_SAVES = 3;
export const DEFAULT_HOURS = 24;
export const KEEP_FILES = 6;
// Separate from the signal profiler's `cpu-*`, so neither prunes the other.
const FILE_PATTERN = /^stall-.*\.cpuprofile$/;
const NS_PER_MS = 1e6;

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

interface LoopDelayHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  /** Nanoseconds. */
  readonly max: number;
}

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
  createHistogram = () => monitorEventLoopDelay({ resolution: 20 }) as LoopDelayHistogram,
  fs = fsPromises as unknown as ProfileFs,
  logger = console as Logger,
}: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createSession?: () => ProfilerSession;
  createHistogram?: () => LoopDelayHistogram;
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
  let histogram: LoopDelayHistogram | null = null;
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
      histogram?.disable();
    } catch {
      // Already disabled.
    }
    histogram = null;
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
    // Our window timer can fire before the histogram's own timer in the same
    // timers phase, and a stall ending right at the boundary is recorded only
    // when that one runs. One setImmediate lets it run first.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const s = session;
    const h = histogram;
    if (stopped || !s || !h) return;
    const maxMs = h.max / NS_PER_MS;
    // An in-process session answers synchronously; awaiting it only adds a
    // microtask, so no timer runs between here and the reset below.
    const { profile } = (await post(s, 'Profiler.stop')) as { profile: unknown };
    if (stopped) return;
    // Reset in the same tick as stop, so our own stop/start pause isn't
    // counted as a stall: reset() also drops the interval in progress. Moved
    // after an await, the profiler would spend its saves on its own overhead.
    h.reset();

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
    histogram = createHistogram();
    histogram.enable();
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
};
// CJS compat: let require() return the module object with named exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
