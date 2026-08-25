/**
 * Retry policy for local wrapper event-processing failures (#782).
 *
 * The kernel deliberately re-delivers an event that the wrapper does not
 * acknowledge. That preserves at-least-once handling, but a flat poll loop
 * turns a model-provider outage into repeated subprocess launches. Keep the
 * retry policy here so every adapter gets the same bounded behavior.
 */

export const SPAWN_FAILURE_CLASS = Object.freeze({
  QUOTA: 'quota',
  RATE_LIMIT: 'rate_limit',
  CONFIGURATION: 'configuration',
  RUNTIME: 'runtime',
});

export const SPAWN_CIRCUIT_THRESHOLD = 3;
// Base ceiling before the stable per-agent 0–20% anti-herd offset.
export const SPAWN_RETRY_MAX_MS = 15 * 60 * 1000;
export const SPAWN_RETRY_JITTER_MAX_RATIO = 0.2;

// This list is a per-provider allowlist, and it only ever grows after an
// outage has already been misclassified. Three times now:
//   2026-08-03  codex  "Your workspace is out of credits."   → `out of credits`
//   2026-08-18  claude "You've hit your session limit"       → `session limit`
//   2026-08-25  claude "You've hit your weekly limit"        → the phrase below
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
//
// The third miss is why there is now a PHRASE as well as a word list, and it is
// a different failure from the first two. Measured across the fleet's logs on
// 2026-08-25: 283 failures reading "You've hit your weekly limit", 55 reading
// "You've hit your session limit" (matched), and 6 reading "You've reached your
// Fable 5 limit" (not matched). Three wordings, one sentence shape, and the
// list had caught exactly one of them. Enumerating per-wording has now failed
// three times because the variable part is a BILLING PERIOD or a MODEL NAME —
// both of which keep being added, so the list is structurally always one
// release behind the provider.
//
// `QUOTA_POSSESSIVE_RE` matches that shape and nothing looser: the subject must
// be the caller's own allowance ("you've hit/reached YOUR ... limit"), which is
// what distinguishes exhaustion from a server-side throttle. The negative
// lookahead keeps "you've hit your rate limit" out — QUOTA is tested first, and
// without it that string would take the 15-minute cooldown instead of the
// 60-second rate-limit backoff. The length bound stops it spanning sentences.
const QUOTA_RE = /(?:quota|usage limit|session limit|weekly limit|credit balance|out of credits|billing|insufficient[_ -]?quota|resource exhausted|spending limit)/i;
const QUOTA_POSSESSIVE_RE = /you'?ve (?:hit|reached) your (?!rate[ -]?limit)[^.\n]{0,40}?limit/i;
const RATE_LIMIT_RE = /(?:rate[ -]?limit|too many requests|\b429\b|overloaded|capacity)/i;
const CONFIGURATION_RE = /(?:ENOENT|command not found|not on PATH|login required|not logged in|invalid api key|authentication failed|unauthori[sz]ed|forbidden|\b40[13]\b)/i;

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
  // Provider APIs commonly report an exhausted account quota as HTTP 429.
  // Prefer the more specific body/message over the generic status code so a
  // hard quota failure gets the long cooldown rather than a one-minute probe.
  if (QUOTA_RE.test(text) || QUOTA_POSSESSIVE_RE.test(text)) return SPAWN_FAILURE_CLASS.QUOTA;
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
    return {
      failureClass,
      circuitOpen: true,
      delayMs: applyJitter(SPAWN_RETRY_MAX_MS, jitterRatio),
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
