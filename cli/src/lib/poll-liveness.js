/**
 * Poll liveness for the inbox loops (TASK-338).
 *
 * The hard timeout in api.js bounds every CAP request, so a poll can no longer
 * hang for good on its own. This is the second net, for whatever the timeout
 * does not cover: if a poll has been in flight past the limit, the loop is
 * wedged, and the only thing that heals it is a fresh process. Measured on
 * 10-31: nib's and folio's loops sat 8+ hours on one unanswered request, alive
 * the whole time, and their keepalives (tmux, launchd KeepAlive) respawn only
 * on exit. So a stall ends the process, loudly, and the keepalive does the rest.
 *
 * The clock runs only while a poll is in flight. A model turn is not a poll, so
 * a two-hour turn never trips it, and neither does a backoff wait: those are
 * timers the loop scheduled itself, and they always fire. Only a request that
 * started and never settled counts.
 */

export const POLL_LIVENESS_DEFAULT_MS = 10 * 60 * 1000;

export const resolvePollLivenessMs = (value, env = process.env) => {
  const candidate = [value, Number(env.COMMONLY_POLL_LIVENESS_MS)]
    .find((ms) => Number.isFinite(ms) && ms > 0);
  return candidate ?? POLL_LIVENESS_DEFAULT_MS;
};

export const createPollLiveness = ({
  limitMs,
  onStall,
  now = Date.now,
  checkEveryMs,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) => {
  let inFlightSince = null;
  let stalled = false;
  const check = () => {
    if (stalled || inFlightSince === null) return;
    const stalledMs = now() - inFlightSince;
    if (stalledMs < limitMs) return;
    stalled = true;
    onStall({ stalledMs, limitMs });
  };
  // A quarter of the limit, so a stall is caught within 1.25x of it, bounded
  // to a check a second at most and one a minute at least.
  const every = Number.isFinite(checkEveryMs) && checkEveryMs > 0
    ? checkEveryMs
    : Math.min(60_000, Math.max(1000, Math.floor(limitMs / 4)));
  const timer = setIntervalImpl(check, every);
  // The check must never be what keeps a stopped loop's process alive.
  timer?.unref?.();
  return {
    begin: () => { inFlightSince = now(); },
    end: () => { inFlightSince = null; },
    check,
    stop: () => { clearIntervalImpl(timer); },
  };
};
