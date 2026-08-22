/**
 * TASK-025: the run loop had a circuit-breaker for auth errors and none for
 * network errors, so a failed fetch retried at a flat interval forever with
 * one indistinct log line per attempt.
 *
 * Each case below pins a property the flat-retry version got wrong. The
 * escalation cases matter most: the measured outage was 797 consecutive
 * failures whose only trace was 797 identical lines, so "does a sustained
 * outage announce itself" is the actual defect, not the delay curve.
 */
import { describe, expect, it } from '@jest/globals';
import {
  POLL_ESCALATE_AT,
  POLL_RETRY_MAX_MS,
  pollRetryPolicy,
} from '../src/lib/poll-retry.js';

const at = (n, over = {}) => pollRetryPolicy({
  consecutiveFailures: n,
  intervalMs: 5000,
  ...over,
});

describe('pollRetryPolicy', () => {
  it('costs a single blip nothing — the first retry is still the poll interval', () => {
    expect(at(1).delayMs).toBe(5000);
  });

  it('backs off exponentially after that, which flat retry never did', () => {
    expect(at(2).delayMs).toBe(10000);
    expect(at(3).delayMs).toBe(20000);
    expect(at(4).delayMs).toBe(40000);
  });

  it('bounds the backoff, so a long outage does not schedule a retry past the ceiling', () => {
    // 2^30 * 5s is ~178 years without the clamp.
    const far = at(30);
    expect(far.delayMs).toBe(POLL_RETRY_MAX_MS);
    expect(far.atCeiling).toBe(true);
  });

  it('escalates on the declared thresholds and stays quiet between them', () => {
    // The whole point: 797 failures must not produce 797 equally loud lines.
    expect(at(3).escalate).toBe(true);
    expect(at(10).escalate).toBe(true);
    expect(at(4).escalate).toBe(false);
    expect(at(9).escalate).toBe(false);
    expect(at(797).escalate).toBe(false);
  });

  it('escalates a bounded number of times across a very long outage', () => {
    const loud = Array.from({ length: 800 }, (_, i) => at(i + 1))
      .filter((r) => r.escalate).length;
    expect(loud).toBe(POLL_ESCALATE_AT.length);
  });

  it('applies anti-herd jitter, clamped so a bad caller cannot widen the window', () => {
    expect(at(2, { jitterRatio: 0.2 }).delayMs).toBe(12000);
    // Over the cap: clamped to 0.2 rather than honoured.
    expect(at(2, { jitterRatio: 5 }).delayMs).toBe(12000);
    expect(at(2, { jitterRatio: -1 }).delayMs).toBe(10000);
    expect(at(2, { jitterRatio: NaN }).delayMs).toBe(10000);
  });

  it('falls back to a sane interval rather than NaN when the caller passes junk', () => {
    expect(pollRetryPolicy({ consecutiveFailures: 1, intervalMs: 0 }).delayMs).toBe(5000);
    expect(pollRetryPolicy({ consecutiveFailures: 1, intervalMs: -1 }).delayMs).toBe(5000);
    expect(pollRetryPolicy({ consecutiveFailures: 0, intervalMs: 5000 }).delayMs).toBe(5000);
    expect(pollRetryPolicy({ intervalMs: 5000 }).delayMs).toBe(5000);
  });
});
