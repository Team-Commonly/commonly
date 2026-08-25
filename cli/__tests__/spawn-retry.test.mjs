import { describe, expect, test } from '@jest/globals';

import {
  SPAWN_FAILURE_CLASS,
  SPAWN_RETRY_MAX_MS,
  classifySpawnFailure,
  formatRetryDelay,
  spawnRetryJitter,
  spawnRetryPolicy,
} from '../src/lib/spawn-retry.js';

describe('spawn retry policy', () => {
  test.each([
    [new Error('insufficient_quota: credit balance exhausted'), SPAWN_FAILURE_CLASS.QUOTA],
    [Object.assign(new Error('429 insufficient_quota'), { status: 429 }), SPAWN_FAILURE_CLASS.QUOTA],
    [Object.assign(new Error('request failed'), { status: 429 }), SPAWN_FAILURE_CLASS.RATE_LIMIT],
    [Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), SPAWN_FAILURE_CLASS.CONFIGURATION],
    [new Error('claude exited with code 1: not logged in'), SPAWN_FAILURE_CLASS.CONFIGURATION],
    [new Error('claude exited with code 1:'), SPAWN_FAILURE_CLASS.RUNTIME],
  ])('classifies %s as %s', (error, expected) => {
    expect(classifySpawnFailure(error)).toBe(expected);
  });

  test('quota and configuration failures open the long circuit immediately', () => {
    for (const error of [new Error('quota exceeded'), new Error('command not found')]) {
      const policy = spawnRetryPolicy({ error, consecutiveFailures: 1, intervalMs: 5000 });
      expect(policy).toMatchObject({ circuitOpen: true, delayMs: SPAWN_RETRY_MAX_MS });
    }
  });

  test('stable agent jitter is bounded and separates fleet probes', () => {
    const alpha = spawnRetryJitter('alpha');
    const beta = spawnRetryJitter('beta');
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThanOrEqual(0.2);
    expect(beta).not.toBe(alpha);
    expect(spawnRetryJitter('alpha')).toBe(alpha);

    const policy = spawnRetryPolicy({
      error: new Error('quota exceeded'),
      consecutiveFailures: 1,
      intervalMs: 5000,
      jitterRatio: 0.2,
    });
    expect(policy.delayMs).toBe(18 * 60 * 1000);
  });

  test('formats jittered delays for operator-facing logs', () => {
    expect(formatRetryDelay(5750)).toBe('5.8s');
    expect(formatRetryDelay(66000)).toBe('1.1m');
  });

  test('unknown failures get two quick retries, then exponential circuit probes', () => {
    const error = new Error('claude exited with code 1:');
    const policies = [1, 2, 3, 4, 8].map((consecutiveFailures) => (
      spawnRetryPolicy({ error, consecutiveFailures, intervalMs: 5000 })
    ));

    expect(policies.map(({ circuitOpen, delayMs }) => ({ circuitOpen, delayMs }))).toEqual([
      { circuitOpen: false, delayMs: 5000 },
      { circuitOpen: false, delayMs: 10000 },
      { circuitOpen: true, delayMs: 60000 },
      { circuitOpen: true, delayMs: 120000 },
      { circuitOpen: true, delayMs: SPAWN_RETRY_MAX_MS },
    ]);
  });

  test('rate-limit probes widen instead of polling once a minute forever', () => {
    const error = Object.assign(new Error('too many requests'), { status: 429 });
    const policies = [1, 2, 3, 4, 5, 20].map((consecutiveFailures) => (
      spawnRetryPolicy({ error, consecutiveFailures, intervalMs: 5000 })
    ));

    expect(policies.map(({ circuitOpen, delayMs }) => ({ circuitOpen, delayMs }))).toEqual([
      { circuitOpen: true, delayMs: 60000 },
      { circuitOpen: true, delayMs: 120000 },
      { circuitOpen: true, delayMs: 240000 },
      { circuitOpen: true, delayMs: 480000 },
      { circuitOpen: true, delayMs: SPAWN_RETRY_MAX_MS },
      { circuitOpen: true, delayMs: SPAWN_RETRY_MAX_MS },
    ]);

    let elapsedMs = 0;
    let attempts = 0;
    while (elapsedMs < 3 * 60 * 60 * 1000) {
      attempts += 1;
      elapsedMs += spawnRetryPolicy({
        error,
        consecutiveFailures: attempts,
        intervalMs: 5000,
      }).delayMs;
    }
    expect(attempts).toBe(15);
  });
});

/**
 * Regression: the classifier is only as good as the failure strings it has
 * actually seen. Both cases below are verbatim from the 2026-08-03 fleet
 * outage, where every one of them classified as RUNTIME — the weakest class,
 * with the shortest backoff — instead of QUOTA.
 */

describe('classifies the Claude CLI session-limit string (2026-08-18 outage)', () => {
  // Verbatim from the fleet stall on 2026-08-18. `QUOTA_RE` already carried
  // "usage limit" — Claude's OTHER exhaustion wording — and missed this one by
  // a single word, so every seat took the RUNTIME ladder (5.6s, 11.2s, 1.1m)
  // against a provider that would not answer until 4am.
  const SESSION_LIMIT = "claude exited with code 1: You've hit your session limit "
    + '· resets 4am (America/Los_Angeles)';

  test("the CLI's session-limit wording is QUOTA, not RUNTIME", () => {
    expect(classifySpawnFailure(new Error(SESSION_LIMIT)))
      .toBe(SPAWN_FAILURE_CLASS.QUOTA);
  });

  test('so it opens the circuit at the full cooldown on the first failure', () => {
    const { circuitOpen, delayMs } = spawnRetryPolicy({
      error: new Error(SESSION_LIMIT),
      consecutiveFailures: 1,
      intervalMs: 5000,
    });
    expect(circuitOpen).toBe(true);
    expect(delayMs).toBe(SPAWN_RETRY_MAX_MS);
  });

  // Guard on the widening, not just the fix. QUOTA is tested before
  // RATE_LIMIT, so a pattern loose enough to match "limit" on its own would
  // swallow every rate-limit error into a 15-minute cooldown.
  test('a rate-limit error is still RATE_LIMIT, not captured by the new pattern', () => {
    expect(classifySpawnFailure(new Error('429 rate limit exceeded, retry shortly')))
      .toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
    expect(classifySpawnFailure(new Error('Too many requests — slow down')))
      .toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
  });
});
describe('classifies real provider-exhaustion strings (2026-08-03 outage)', () => {
  test("codex's exact out-of-credits wording is QUOTA, not RUNTIME", () => {
    const error = new Error(
      'codex turn failed: Your workspace is out of credits. '
      + 'Ask your workspace owner to refill in order to continue.',
    );
    expect(classifySpawnFailure(error)).toBe(SPAWN_FAILURE_CLASS.QUOTA);
  });

  test('a QUOTA verdict opens the circuit on the very first failure', () => {
    // The point of classifying it correctly: RUNTIME grants two free retries
    // before tripping, QUOTA trips immediately at the full cooldown.
    const error = new Error('Your workspace is out of credits.');
    const { circuitOpen, delayMs, failureClass } = spawnRetryPolicy({
      error,
      consecutiveFailures: 1,
      intervalMs: 5000,
    });
    expect(failureClass).toBe(SPAWN_FAILURE_CLASS.QUOTA);
    expect(circuitOpen).toBe(true);
    expect(delayMs).toBe(SPAWN_RETRY_MAX_MS);
  });

  test('a claude usage-limit message reported on stdout is QUOTA once surfaced', () => {
    // The adapter used to drop stdout on failure, so this arrived as the empty
    // string and was unclassifiable. See adapters.claude.test.mjs.
    const error = new Error(
      'claude exited with code 1: Claude usage limit reached. '
      + 'Your limit will reset at 11:40pm.',
    );
    expect(classifySpawnFailure(error)).toBe(SPAWN_FAILURE_CLASS.QUOTA);
  });

  test('an empty failure message still classifies, as RUNTIME', () => {
    // What every one of the 361 claude failures looked like before the fix.
    expect(classifySpawnFailure(new Error('claude exited with code 1: ')))
      .toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });
});

describe('classifies the possessive-exhaustion phrase (2026-08-25, third miss)', () => {
  // Verbatim from the fleet's own logs, measured 2026-08-25 across every seat
  // that had failed at all. Three wordings, one sentence shape, and the
  // allowlist carried exactly one of them:
  //
  //   283 × "You've hit your weekly limit"      <- unmatched, RUNTIME ladder
  //    55 × "You've hit your session limit"     <- matched (the 08-18 fix)
  //     6 × "You've reached your Fable 5 limit" <- unmatched, RUNTIME ladder
  //
  // Enumerating per-wording has now failed three times, because the variable
  // part is a billing period or a model name — both of which the provider keeps
  // adding. Hence a phrase for the shape, kept narrow by requiring the caller's
  // OWN allowance to be the subject.
  const WEEKLY = "claude exited with code 1: You've hit your weekly limit "
    + '· resets Aug 27 at 2pm (America/Los_Angeles)';
  const PER_MODEL = "claude exited with code 1: You've reached your Fable 5 limit";

  test.each([
    ['weekly, the wording behind 283 of 365 fleet failures', WEEKLY],
    ['per-model, whose variable part is a model name', PER_MODEL],
  ])('%s is QUOTA, not RUNTIME', (_label, message) => {
    expect(classifySpawnFailure(new Error(message))).toBe(SPAWN_FAILURE_CLASS.QUOTA);
  });

  test('so the circuit opens at the full cooldown on the FIRST failure', () => {
    const { circuitOpen, delayMs } = spawnRetryPolicy({
      error: new Error(WEEKLY),
      consecutiveFailures: 1,
      intervalMs: 5000,
    });
    expect(circuitOpen).toBe(true);
    expect(delayMs).toBe(SPAWN_RETRY_MAX_MS);
  });

  // This is the specific harm the misclassification caused, and it is not the
  // latency. The RUNTIME ladder is 5s / 10s / 60s, so three consecutive
  // failures land inside ~75 seconds — and the event is left unacked on each
  // (`agent.js`, "the kernel must retain the event for at-least-once
  // delivery"), which burns all three `requeueMaxAttempts` and retires it to
  // `status: 'failed'`. Under QUOTA the first failure alone opens a 15-minute
  // circuit, so the batch is not spent. See TASK-061.
  test('the RUNTIME ladder would burn all three requeue attempts inside 75s', () => {
    const runtimeLadder = [1, 2, 3].map((n) => spawnRetryPolicy({
      error: new Error('claude exited with code 1: something transient'),
      consecutiveFailures: n,
      intervalMs: 5000,
    }).delayMs);
    expect(runtimeLadder.reduce((a, b) => a + b, 0)).toBeLessThan(90 * 1000);

    // The same three failures, correctly classified, cost 45 minutes.
    const quotaLadder = [1, 2, 3].map((n) => spawnRetryPolicy({
      error: new Error(WEEKLY),
      consecutiveFailures: n,
      intervalMs: 5000,
    }).delayMs);
    expect(quotaLadder.every((ms) => ms === SPAWN_RETRY_MAX_MS)).toBe(true);
  });

  // Guard on the widening. The phrase requires "your", so a server-side
  // throttle phrased the same way must not be swallowed into the 15-minute
  // cooldown — QUOTA is tested before RATE_LIMIT, so this ordering is load-bearing.
  test.each([
    "You've hit your rate limit, retry shortly",
    "You've reached your rate-limit for this model",
  ])('a possessive RATE-limit string stays RATE_LIMIT: %s', (message) => {
    expect(classifySpawnFailure(new Error(message))).toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
  });

  // And the bound stops it spanning sentences into an unrelated word.
  test('the phrase does not span a sentence boundary', () => {
    expect(classifySpawnFailure(new Error("You've hit your stride. Now describe the limit.")))
      .toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });
});
