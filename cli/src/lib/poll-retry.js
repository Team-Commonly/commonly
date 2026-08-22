/**
 * Retry policy for the run loop's own FETCH failures (TASK-025).
 *
 * `spawn-retry.js` bounds failures of the subprocess a poll produces. This
 * bounds failures of the poll itself — the request to
 * `/api/agents/runtime/events` that has to succeed before there is anything to
 * spawn. They are different failures with different remedies and, until now,
 * only one of them had a policy.
 *
 * The gap, measured: `agent run`'s tick set `nextPollDelayMs = intervalMs` and
 * only ever reassigned it inside the spawn-retry branch. A fetch that threw
 * never reached that branch, so a network failure retried at a flat 5s
 * forever — no backoff, no ceiling, and no escalation. 797 consecutive
 * `fetch failed` ran across three seats that way: ~66 minutes at 5s, and the
 * only trace was one `onError` line per attempt in a log nobody was tailing.
 *
 * Two deliberate differences from the auth path directly above it:
 *
 * 1. NO STOP. `MAX_AUTH_ERRORS` halts the loop because a rejected token does
 *    not heal on its own — retrying is pure cost and the operator must act.
 *    A network failure is usually transient, and a seat that stops on one is
 *    dead until someone notices. So this backs off and stays alive.
 *
 * 2. ESCALATION IS THE POINT. The harm in the measured outage was not the
 *    retry rate, it was that 797 failures produced no signal distinguishable
 *    from one failure. `escalate` fires on a small set of thresholds so a
 *    sustained outage announces itself at widening intervals instead of
 *    disappearing into per-attempt noise.
 */

// Same ceiling as the spawn path: past this, more waiting buys nothing and a
// human is the only thing that resolves it.
export const POLL_RETRY_MAX_MS = 15 * 60 * 1000;

// Backoff starts only after the first failure has been retried once at the
// normal interval, so a single blip costs nothing.
export const POLL_BACKOFF_AFTER = 1;

// Failure counts that emit a loud line. Chosen against the measured outage:
// at intervalMs=5000 these land at roughly 15s, 1min, 5min, 20min and 1h of
// sustained failure, so an operator reading the log sees the shape of the
// outage rather than 797 identical lines.
export const POLL_ESCALATE_AT = Object.freeze([3, 10, 30, 60, 120]);

/**
 * Next poll delay after a failed fetch, and whether this attempt should be
 * announced loudly.
 *
 * Exponential from `intervalMs`, bounded by POLL_RETRY_MAX_MS. Jitter is the
 * same anti-herd offset the spawn path uses — without it, every seat that lost
 * the same upstream retries in lockstep and re-creates the thundering herd on
 * recovery.
 */
export const pollRetryPolicy = ({
  consecutiveFailures,
  intervalMs,
  jitterRatio = 0,
}) => {
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000;
  const failureCount = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0
    ? consecutiveFailures
    : 1;

  const steps = Math.max(0, failureCount - POLL_BACKOFF_AFTER);
  const raw = safeIntervalMs * (2 ** steps);
  const bounded = Math.min(POLL_RETRY_MAX_MS, raw);

  // Clamp rather than trust the caller: a jitterRatio above the cap would
  // widen the herd window instead of narrowing it.
  const safeJitter = Number.isFinite(jitterRatio)
    ? Math.min(0.2, Math.max(0, jitterRatio))
    : 0;

  return {
    delayMs: Math.round(bounded * (1 + safeJitter)),
    escalate: POLL_ESCALATE_AT.includes(failureCount),
    atCeiling: bounded >= POLL_RETRY_MAX_MS,
  };
};

export default pollRetryPolicy;
