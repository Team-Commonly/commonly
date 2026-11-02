import { monitorEventLoopDelay } from 'perf_hooks';

/**
 * Logs each 10-second window in which the event loop stalled past a threshold
 * (1s by default), with the worst delay and the 99th percentile.
 *
 * A stall used to be inferred from gaps in the logs and from probe failures,
 * and both misled. On 2026-11-02 a 7–9s quiet stretch on the five-minute tick
 * was read as a blocked loop. It was a pass making 169 sequential database
 * round trips, while socket lines kept logging mid-pass. The readiness probe
 * now tolerates about 30s (#3293), so a shorter stall shows up nowhere else.
 * The histogram measures the loop itself: a window is logged only when some
 * callback actually waited that long to run.
 */

export interface LoopDelayHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  /** Nanoseconds. */
  readonly max: number;
  /** Nanoseconds. */
  percentile(p: number): number;
}

const NS_PER_MS = 1e6;

export const startEventLoopLagMonitor = ({
  thresholdMs = Number(process.env.EVENT_LOOP_LAG_WARN_MS) || 1000,
  windowMs = 10_000,
  histogram = monitorEventLoopDelay({ resolution: 20 }) as LoopDelayHistogram,
  log = (line: string) => console.warn(line),
}: {
  thresholdMs?: number;
  windowMs?: number;
  histogram?: LoopDelayHistogram;
  log?: (line: string) => void;
} = {}): (() => void) => {
  histogram.enable();
  const timer = setInterval(() => {
    const maxMs = histogram.max / NS_PER_MS;
    if (maxMs >= thresholdMs) {
      const p99Ms = histogram.percentile(99) / NS_PER_MS;
      log(`[loop-lag] max=${Math.round(maxMs)}ms p99=${Math.round(p99Ms)}ms window=${windowMs / 1000}s`);
    }
    histogram.reset();
  }, windowMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
};

export default { startEventLoopLagMonitor };
// CJS compat: let require() return the module object with named exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
