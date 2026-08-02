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
