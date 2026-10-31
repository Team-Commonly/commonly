/**
 * Poll liveness for the inbox loops (TASK-338).
 *
 * The hard timeout in api.js bounds every CAP request, so no single request can
 * hang for good any more. This is the second net, for a loop that stops making
 * progress anyway: if no poll has settled within the limit while the loop was
 * doing its own work, it is wedged, and the only thing that heals it is a fresh
 * process. Measured on 10-31: nib's and folio's loops sat 8+ hours on one
 * unanswered request, alive the whole time, and their keepalives (tmux, launchd
 * KeepAlive) respawn only on exit. So a stall ends the process, loudly, and the
 * keepalive does the rest.
 *
 * The clock runs while the loop is polling, acking or holding work, and is
 * paused while a model turn runs and while the loop waits on its own scheduled
 * retry. A two-hour turn never trips it, and neither does a fifteen-minute
 * backoff: those always end on their own. A settled poll or a finished turn
 * restarts the clock.
 *
 * Monotonic time, not Date.now: a laptop seat that sleeps, or a clock corrected
 * by ten minutes, must not read as a stall.
 */
import { performance } from 'perf_hooks';

export const POLL_LIVENESS_DEFAULT_MS = 10 * 60 * 1000;

export const resolvePollLivenessMs = (value, env = process.env) => {
  const candidate = [value, Number(env.COMMONLY_POLL_LIVENESS_MS)]
    .find((ms) => Number.isFinite(ms) && ms > 0);
  return candidate ?? POLL_LIVENESS_DEFAULT_MS;
};

export const formatStall = (ms) => (ms < 60_000
  ? `${Math.max(1, Math.round(ms / 1000))}s`
  : `${Math.round(ms / 60_000)} min`);

export const createPollLiveness = ({ limitMs, onStall, checkEveryMs }) => {
  let armedSince = null;
  let stalled = false;
  // A quarter of the limit, so a stall is caught within 1.25x of it, bounded
  // to a check a second at most and one a minute at least.
  const every = Number.isFinite(checkEveryMs) && checkEveryMs > 0
    ? checkEveryMs
    : Math.min(60_000, Math.max(1000, Math.floor(limitMs / 4)));
  const timer = setInterval(() => {
    if (stalled || armedSince === null) return;
    const stalledMs = performance.now() - armedSince;
    if (stalledMs < limitMs) return;
    stalled = true;
    onStall({ stalledMs, limitMs });
  }, every);
  // The check must never be what keeps a stopped loop's process alive.
  timer.unref?.();
  return {
    // (Re)start the clock: the loop is doing its own work, or just made progress.
    arm: () => { armedSince = performance.now(); },
    // Stop the clock: a model turn, or a wait the loop scheduled itself.
    pause: () => { armedSince = null; },
    stop: () => { clearInterval(timer); },
  };
};
