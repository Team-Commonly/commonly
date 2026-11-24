/**
 * F597: the events poll's long-poll (`GET /api/agents/runtime/events?waitMs=`).
 *
 * A current server holds an empty poll open up to `waitMs` (at most 25 s) and
 * answers as soon as an event can be claimed, so an idle agent asks about once
 * per 25 s instead of every ~5 s, and a new event still arrives at once.
 *
 * An older server ignores the parameter and answers an empty poll at once.
 * The loop must then keep its normal interval, never spin: an empty answer
 * that came back in well under the requested wait was not held, and is
 * treated exactly like today's empty poll.
 */
import { capTimeoutMs } from './cap-timeout.js';

export const LONG_POLL_MAX_WAIT_MS = 25_000;
// The hold must end, and its answer arrive, before the request's own timeout.
export const LONG_POLL_TIMEOUT_MARGIN_MS = 5_000;
// Below this the hold buys nothing over the ordinary interval.
const LONG_POLL_MIN_WAIT_MS = 1_000;

/** The wait to ask for: 0 (no long-poll) when the read timeout leaves no room. */
export const longPollWaitMs = ({ env = process.env } = {}) => {
  const room = capTimeoutMs('read', { env }) - LONG_POLL_TIMEOUT_MARGIN_MS;
  const wait = Math.min(LONG_POLL_MAX_WAIT_MS, room);
  return wait >= LONG_POLL_MIN_WAIT_MS ? wait : 0;
};

/**
 * The hold a loop may ask for under its poll-liveness limit
 * (lib/poll-liveness.js): the liveness clock runs while the poll is in flight,
 * so a hold near the limit would read as a wedged loop and stop the run. The
 * hold ends a margin before the limit (5 s or a quarter of it, whichever is
 * larger); if what is left is under LONG_POLL_MIN_LIVENESS_HOLD_MS, no hold.
 */
export const LONG_POLL_MIN_LIVENESS_HOLD_MS = 3_000;
export const clampHoldToLiveness = (holdMs, livenessMs) => {
  if (!(holdMs > 0)) return 0;
  if (!Number.isFinite(livenessMs) || livenessMs <= 0) return holdMs;
  const room = Math.floor(livenessMs - Math.max(5_000, livenessMs / 4));
  return room >= LONG_POLL_MIN_LIVENESS_HOLD_MS ? Math.min(holdMs, room) : 0;
};

/**
 * Whether an empty answer was a held one, so the next poll can go at once.
 * Half the requested wait is the line: an old server answers in milliseconds,
 * a held poll that timed out answers at about the full wait.
 */
export const wasHeld = ({ requestedMs, elapsedMs }) => (
  requestedMs > 0 && elapsedMs >= requestedMs / 2
);
