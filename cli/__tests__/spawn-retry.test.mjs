import { describe, expect, jest, test } from '@jest/globals';

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

  test('a named quota reset holds the first probe until after the reset', () => {
    const now = Date.parse('2026-10-23T09:57:37Z'); // 2:57:37am in Los Angeles
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const error = new Error(
        "claude exited with code 1: You've hit your session limit "
        + '· resets 4:20am (America/Los_Angeles)',
      );
      const policy = spawnRetryPolicy({ error, consecutiveFailures: 1, intervalMs: 5000 });
      expect(policy).toEqual({
        failureClass: SPAWN_FAILURE_CLASS.QUOTA,
        circuitOpen: true,
        delayMs: Date.parse('2026-10-23T11:22:00Z') - now,
      });
      expect(spawnRetryPolicy({
        error, consecutiveFailures: 2, intervalMs: 5000, jitterRatio: 0.2,
      }).delayMs).toBe(policy.delayMs + 24_000);
    } finally {
      clock.mockRestore();
    }
  });

  test('a reset clock across midnight still names the next local day', () => {
    const now = Date.parse('2026-10-23T06:55:00Z'); // 11:55pm in Los Angeles
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const policy = spawnRetryPolicy({
        error: new Error('session limit · resets 12:10am (America/Los_Angeles)'),
        consecutiveFailures: 1,
        intervalMs: 5000,
      });
      expect(policy.delayMs).toBe(17 * 60 * 1000);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    ['spring forward', '2026-03-08T09:30:00Z', '2026-03-08T11:22:00Z'],
    ['fall back', '2026-11-01T07:30:00Z', '2026-11-01T12:22:00Z'],
  ])('a quota reset across the %s clock change uses the named zone', (_, nowText, probeText) => {
    const now = Date.parse(nowText);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const policy = spawnRetryPolicy({
        error: new Error('session limit · resets 4:20am (America/Los_Angeles)'),
        consecutiveFailures: 1,
        intervalMs: 5000,
      });
      expect(policy.delayMs).toBe(Date.parse(probeText) - now);
    } finally {
      clock.mockRestore();
    }
  });

  test('an invalid reset hint keeps the bounded quota fallback', () => {
    const policy = spawnRetryPolicy({
      error: new Error('session limit · resets 25:99am (America/Los_Angeles)'),
      consecutiveFailures: 1,
      intervalMs: 5000,
    });
    expect(policy.delayMs).toBe(SPAWN_RETRY_MAX_MS);
  });

  test('a just-passed reset clock does not defer the next probe for a day', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T11:21:00Z'));
    try {
      const policy = spawnRetryPolicy({
        error: new Error('session limit · resets 4:20am (America/Los_Angeles)'),
        consecutiveFailures: 1,
        intervalMs: 5000,
      });
      expect(policy.delayMs).toBe(SPAWN_RETRY_MAX_MS);
    } finally {
      clock.mockRestore();
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

  test('so it opens the circuit until the stated reset on the first failure (TASK-380)', () => {
    const now = Date.parse('2026-08-18T10:00:00Z'); // 3am in Los Angeles
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { circuitOpen, delayMs } = spawnRetryPolicy({
        error: new Error(SESSION_LIMIT),
        consecutiveFailures: 1,
        intervalMs: 5000,
      });
      expect(circuitOpen).toBe(true);
      expect(delayMs).toBe(62 * 60 * 1000);
    } finally {
      clock.mockRestore();
    }
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
