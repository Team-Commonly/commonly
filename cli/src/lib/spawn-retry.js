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

const QUOTA_RE = /(?:quota|usage limit|credit balance|billing|insufficient[_ -]?quota|resource exhausted|spending limit)/i;
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
      delayMs: applyJitter(60 * 1000, jitterRatio),
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
