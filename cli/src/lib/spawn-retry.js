/**
 * Retry policy for local wrapper event-processing failures (#782).
 *
 * The kernel deliberately re-delivers an event that the wrapper does not
 * acknowledge. That preserves at-least-once handling, but a flat poll loop
 * turns a model-provider outage into repeated subprocess launches. Keep the
 * retry policy here so every adapter gets the same bounded behavior.
 */

export const SPAWN_FAILURE_CLASS = Object.freeze({
  // The provider refused the request's CONTENT. Re-sending the same content
  // can only be refused again, so this class is never retried: the run loop
  // acks the event as refused instead (lib/content-refusal.js).
  CONTENT_REFUSED: 'content_refused',
  QUOTA: 'quota',
  RATE_LIMIT: 'rate_limit',
  CONFIGURATION: 'configuration',
  RUNTIME: 'runtime',
});

export const SPAWN_CIRCUIT_THRESHOLD = 3;
// Fallback ceiling when an error has no usable reset clock.
export const SPAWN_RETRY_MAX_MS = 15 * 60 * 1000;
export const SPAWN_RETRY_JITTER_MAX_RATIO = 0.2;

// This list is a per-provider allowlist, and it only ever grows after an
// outage has already been misclassified. Twice now:
//   2026-08-03  codex  "Your workspace is out of credits."   → `out of credits`
//   2026-08-18  claude "You've hit your session limit"       → `session limit`
// The second one is the instructive failure: `usage limit` was already here —
// it is Claude's OTHER exhaustion wording — so the fleet stalled for an hour on
// a string one word away from a pattern we had. Both times the miss meant
// RUNTIME, the weakest class with the shortest backoff, against a provider that
// was not going to answer for hours.
//
// What a miss costs, measured against these constants (intervalMs 5000,
// jitter 0; `*` = circuit open):
//
//   quota          n=1,2,3 ->  900s*  900s*  900s*
//   configuration  n=1,2,3 ->  900s*  900s*  900s*
//   rate_limit     n=1,2,3 ->   60s*  120s*  240s*
//   runtime        n=1,2,3 ->    5s     10s    60s*
//
// So an unmatched wording is not one class off — it is 180x faster on the
// first retry than the class it belonged in, and the only class that does not
// open the circuit at n=1. That is the price of a missing string, and it is
// why the entry below is a list of exact wordings rather than a loose pattern.
//
// Note RUNTIME is also `classifySpawnFailure`'s fallthrough, so "unrecognised"
// and "transient local fault" resolve to the same, most aggressive schedule.
// That is a structural issue rather than a vocabulary one — see #996.
//
// Deliberately NOT loosened to a bare `limit`: QUOTA is tested before
// RATE_LIMIT, so that would swallow every "rate limit" error into the 15-minute
// cooldown. Add exact wordings, not looser ones.
// Measured 2026-10-16 from a codex seat (gpt-6-astra over the ChatGPT login),
// on a security-gate request carrying SSRF/exfil/ReDoS test cases: "codex turn
// failed: This content was flagged for possible cybersecurity risk. If this
// seems wrong, try rephrasing your request. If you're doing authorized security
// work … apply for Daybreak access …". Classed as `runtime`, it was re-sent on
// backoff 5 times in 52 minutes, every one refused, and the seat handled
// nothing else until the kernel retired the event. Only the refusal wordings
// themselves are matched, so an ordinary failure that mentions a flag is not.
const CONTENT_REFUSED_RE = /(?:flagged for possible cybersecurity risk|this content was flagged|content[_ ]policy[_ ]violation|cyber[_ ]policy)/i;
const QUOTA_RE = /(?:quota|usage limit|session limit|credit balance|out of credits|billing|insufficient[_ -]?quota|resource exhausted|spending limit)/i;
const RATE_LIMIT_RE = /(?:rate[ -]?limit|too many requests|\b429\b|overloaded|capacity)/i;
const CONFIGURATION_RE = /(?:ENOENT|command not found|not on PATH|login required|not logged in|invalid api key|authentication failed|unauthori[sz]ed|forbidden|\b40[13]\b)/i;
const QUOTA_RESET_RE = /\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_]+(?:\/[A-Za-z_]+)+)\)/i;
const QUOTA_RESET_MARGIN_MS = 2 * 60 * 1000;

const errorText = (error) => [
  error?.message,
  error?.stderr,
  error?.body?.error,
  error?.body?.message,
]
  .filter(Boolean)
  .map(String)
  .join('\n');

export const classifySpawnFailure = (error) => {
  const text = errorText(error);
  // First: the refusal text carries none of the words below today, but a
  // refusal must never be read as a transient condition and retried.
  if (CONTENT_REFUSED_RE.test(text)) return SPAWN_FAILURE_CLASS.CONTENT_REFUSED;
  // Provider APIs commonly report an exhausted account quota as HTTP 429.
  // Prefer the more specific body/message over the generic status code so a
  // hard quota failure gets the long cooldown rather than a one-minute probe.
  if (QUOTA_RE.test(text)) return SPAWN_FAILURE_CLASS.QUOTA;
  if (error?.status === 429 || RATE_LIMIT_RE.test(text)) {
    return SPAWN_FAILURE_CLASS.RATE_LIMIT;
  }
  if (
    error?.code === 'ENOENT'
    || error?.status === 401
    || error?.status === 403
    || CONFIGURATION_RE.test(text)
  ) {
    return SPAWN_FAILURE_CLASS.CONFIGURATION;
  }
  return SPAWN_FAILURE_CLASS.RUNTIME;
};

// A stable per-agent offset keeps a fleet from probing a recovering provider
// in lockstep. Stability matters: random jitter makes operator logs and tests
// harder to reason about, while distinct agent names already provide entropy.
export const spawnRetryJitter = (agentName) => {
  let hash = 2166136261;
  for (const char of String(agentName || 'agent')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 2001) / 10000;
};

const applyJitter = (delayMs, jitterRatio) => {
  const safeJitter = Number.isFinite(jitterRatio)
    ? Math.min(SPAWN_RETRY_JITTER_MAX_RATIO, Math.max(0, jitterRatio))
    : 0;
  return Math.round(delayMs * (1 + safeJitter));
};

// Claude names the local reset clock in its quota error. Waiting for that
// clock avoids repeatedly launching a seat that cannot answer before then.
// If the hint is absent or malformed, keep the ordinary bounded retry path.
const quotaResetDelay = (error, now = Date.now()) => {
  const match = QUOTA_RESET_RE.exec(errorText(error));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const target = ((hour % 12) + (match[3].toLowerCase() === 'pm' ? 12 : 0)) * 60 + minute;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: match[4], hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return null;
  }
  const localMinute = (instant) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    return Number(parts.hour) * 60 + Number(parts.minute);
  };
  const nowMinute = localMinute(now);
  const wallMinutes = (target - nowMinute + 1440) % 1440;
  // At or just after the named minute, the message may be a stale failure
  // from the old quota window. Probe on the ordinary cooldown instead of
  // assuming the next reset is nearly 24 hours away.
  if (wallMinutes === 0 || wallMinutes > 1430) return null;
  let resetAt = now - (now % 60000) + wallMinutes * 60 * 1000;
  // Crossing a daylight-saving boundary can shift the initial wall-clock
  // estimate by an hour. Reconcile against the target in the named zone.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const difference = (target - localMinute(resetAt) + 1440) % 1440;
    if (difference === 0) break;
    resetAt += (difference > 720 ? difference - 1440 : difference) * 60 * 1000;
  }
  if (resetAt <= now || localMinute(resetAt) !== target) return null;
  return resetAt - now + QUOTA_RESET_MARGIN_MS;
};

/**
 * Return the next probe delay and whether the circuit is open.
 *
 * Known non-transient failures open immediately. Unknown runtime failures get
 * two quick retries, then open the circuit on the third consecutive failure.
 * Later probes back off exponentially to the same 15-minute base ceiling.
 */
export const spawnRetryPolicy = ({
  error,
  consecutiveFailures,
  intervalMs,
  jitterRatio = 0,
}) => {
  const failureClass = classifySpawnFailure(error);
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000;
  const failureCount = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0
    ? consecutiveFailures
    : 1;

  if (
    failureClass === SPAWN_FAILURE_CLASS.QUOTA
    || failureClass === SPAWN_FAILURE_CLASS.CONFIGURATION
  ) {
    const resetDelay = failureClass === SPAWN_FAILURE_CLASS.QUOTA
      ? quotaResetDelay(error)
      : null;
    return {
      failureClass,
      circuitOpen: true,
      // Spread the reset probe by at most 24 seconds, not a percentage of
      // the entire wait: a six-hour hint must not add an hour of lag.
      delayMs: resetDelay === null
        ? applyJitter(SPAWN_RETRY_MAX_MS, jitterRatio)
        : resetDelay + applyJitter(QUOTA_RESET_MARGIN_MS, jitterRatio) - QUOTA_RESET_MARGIN_MS,
    };
  }

  if (failureClass === SPAWN_FAILURE_CLASS.RATE_LIMIT) {
    return {
      failureClass,
      circuitOpen: true,
      delayMs: applyJitter(
        Math.min(
          SPAWN_RETRY_MAX_MS,
          60 * 1000 * (2 ** (failureCount - 1)),
        ),
        jitterRatio,
      ),
    };
  }

  if (failureCount < SPAWN_CIRCUIT_THRESHOLD) {
    return {
      failureClass,
      circuitOpen: false,
      delayMs: applyJitter(
        Math.min(
          SPAWN_RETRY_MAX_MS,
          safeIntervalMs * (2 ** (failureCount - 1)),
        ),
        jitterRatio,
      ),
    };
  }

  return {
    failureClass,
    circuitOpen: true,
    delayMs: applyJitter(
      Math.min(
        SPAWN_RETRY_MAX_MS,
        60 * 1000 * (2 ** (failureCount - SPAWN_CIRCUIT_THRESHOLD)),
      ),
      jitterRatio,
    ),
  };
};

export const formatRetryDelay = (delayMs) => {
  if (delayMs >= 60000) {
    const minutes = delayMs / 60000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  if (delayMs >= 1000) {
    const seconds = delayMs / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  return `${delayMs}ms`;
};
