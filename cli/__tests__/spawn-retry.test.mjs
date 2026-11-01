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
  // Re-measured on main 54eb2abc8 before this change: all four wordings in this
  // file's QUOTA cases below still classified RUNTIME, so the gap is live.
  const WEEKLY = "claude exited with code 1: You've hit your weekly limit "
    + '· resets Aug 27 at 2pm (America/Los_Angeles)';
  const PER_MODEL = "claude exited with code 1: You've reached your Fable 5 limit";

  test.each([
    ['weekly, the wording behind 283 of 365 fleet failures', WEEKLY],
    ['per-model, whose variable part is a model name', PER_MODEL],
    // The HTTP status is a prefix here, not a throttle wording. A hold on
    // #2553: this shape classed RUNTIME_LIMIT's 60s probe.
    ['per-model behind an HTTP 429 prefix', "429: You've reached your Fable 5 limit"],
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
  // (agent.js, "the kernel must retain the event for at-least-once delivery"),
  // which burns all three requeue attempts and retires it to `status: 'failed'`.
  // Under QUOTA the first failure alone opens a 15-minute circuit.
  test('the RUNTIME ladder would burn all three requeue attempts inside 90s', () => {
    const runtimeLadder = [1, 2, 3].map((n) => spawnRetryPolicy({
      error: new Error('claude exited with code 1: something transient'),
      consecutiveFailures: n,
      intervalMs: 5000,
    }).delayMs);
    expect(runtimeLadder.reduce((a, b) => a + b, 0)).toBeLessThan(90 * 1000);

    const quotaLadder = [1, 2, 3].map((n) => spawnRetryPolicy({
      error: new Error(WEEKLY),
      consecutiveFailures: n,
      intervalMs: 5000,
    }).delayMs);
    expect(quotaLadder.every((ms) => ms === SPAWN_RETRY_MAX_MS)).toBe(true);
  });

  // Guard on the widening. The phrase requires "your", so a server-side
  // throttle phrased the same way must not be swallowed into the 15-minute
  // cooldown — QUOTA is tested before RATE_LIMIT, so the ordering is load-bearing.
  test.each([
    "You've hit your rate limit, retry shortly",
    "You've reached your rate-limit for this model",
    // Capitalised, because the lookahead's `i` is load-bearing and invisible.
    "you've hit your Rate Limit",
    // The lookahead only guards the word IMMEDIATELY after "your", so these
    // two walked past it into the 15-minute circuit while main correctly gave
    // the 60-second probe — a regression this branch introduced and the
    // gate on #2491 caught. The call site now refuses the possessive shape
    // whenever a throttle wording appears anywhere in the text.
    "You've hit your API rate limit",
    "You've reached your per-model rate limit",
    "You've hit your organisation's rate limit for this model",
  ])('a possessive RATE-limit string stays RATE_LIMIT: %s', (message) => {
    expect(classifySpawnFailure(new Error(message))).toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
  });

  // The boundary of that refusal, in the other direction: an explicit quota
  // WORD still wins, because QUOTA_RE is tested before the possessive shape.
  // Otherwise a provider sentence that names both would lose the long cooldown
  // it needs.
  test('an explicit quota word beats a rate-limit mention in the same message', () => {
    expect(classifySpawnFailure(new Error(
      'Claude usage limit reached; standard rate limits also apply.',
    ))).toBe(SPAWN_FAILURE_CLASS.QUOTA);
  });

  test('the phrase does not span a sentence boundary', () => {
    expect(classifySpawnFailure(new Error("You've hit your stride. Now describe the limit.")))
      .toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });

  describe('the dotted-model-name gap (sprint-review, 2026-08-25)', () => {
    // `[^.\n]` was chosen to keep the match inside one sentence, and silently
    // also excluded every model name we run, because they are all dotted.
    // RUNTIME is the fallthrough with the SHORTEST backoff, so the net effect
    // was to probe a quota-blocked seat hardest.
    test.each([
      ["You've reached your Haiku 4.5 limit"],
      ["you've hit your gpt-5.4-mini limit"],
      ["Error: You've reached your Claude Opus 4.8 limit for today"],
    ])('classifies %s as QUOTA', (text) => {
      expect(classifySpawnFailure(new Error(text))).toBe(SPAWN_FAILURE_CLASS.QUOTA);
    });

    test('still refuses a rate limit, which QUOTA is tested before', () => {
      expect(classifySpawnFailure(new Error("you've hit your rate limit")))
        .toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
    });

    // RENAMED from "does not let the dot carve-out span a sentence boundary",
    // which sprint-review's gate on #1215 showed was vacuous: it passed
    // identically with and without the carve-out, because a LETTER follows the
    // period there and plain `[^.\n]` already excluded that. What the pattern
    // actually has is weaker, and this is it — the space after the period is
    // what ends the match.
    test('a period followed by a SPACE still terminates the match', () => {
      expect(classifySpawnFailure(new Error("You've reached your goal. 5 things have no limit")))
        .not.toBe(SPAWN_FAILURE_CLASS.QUOTA);
    });

    // The documented limit, asserted so it cannot drift unnoticed: a digit
    // immediately after the period IS admitted, even at a sentence boundary.
    // Kept rather than tightened — adjacent `.`+digit is rare in provider copy,
    // and the alternative predicate is harder to read than the bug is costly.
    test('a period followed immediately by a DIGIT is admitted — known and accepted', () => {
      expect(classifySpawnFailure(new Error("You've reached your goal.5 things have no limit")))
        .toBe(SPAWN_FAILURE_CLASS.QUOTA);
    });

    // The {0,40} bound counts alternation units, so a long model name falls
    // through to RUNTIME by design. Pinned because nothing else pins it.
    test('past the length bound it falls through to RUNTIME', () => {
      expect(classifySpawnFailure(new Error(
        "You've reached your extremely verbose vendor model name 4.5 preview limit",
      ))).toBe(SPAWN_FAILURE_CLASS.RUNTIME);
    });

    test('a dotted model name costs the quota ladder, not the runtime ladder', () => {
      const policy = spawnRetryPolicy({
        error: new Error("You've reached your Haiku 4.5 limit"),
        consecutiveFailures: 1,
        intervalMs: 5000,
      });
      expect(policy).toMatchObject({ circuitOpen: true, delayMs: SPAWN_RETRY_MAX_MS });
    });
  });
});

// TASK-256: a public seat's withheld turn carries the tool's own error text in
// its message, so a vendor that says "content_policy_violation", "quota" or
// "403 forbidden" must not decide the class. The code does: the event stays
// unacked and is retried, never acked as refused.
describe('a public witness failure is a runtime failure, whatever its text says', () => {
  test.each([
    ['public_tool_failed', '{"status":500,"message":"content_policy_violation"}'],
    ['public_tool_failed', 'this content was flagged'],
    ['public_tool_failed', 'insufficient_quota'],
    ['public_tool_failed', '403 forbidden'],
    ['public_mcp_not_ready', 'rate limit while connecting'],
  ])('%s with "%s" classes as runtime', (code, reason) => {
    const error = new Error(`public seat withheld this turn's reply: Commonly tool x failed (${reason})`);
    error.code = code;
    expect(classifySpawnFailure(error)).toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });

  test('positive control: the same text without the code still classes as a refusal', () => {
    expect(classifySpawnFailure(new Error('{"status":500,"message":"content_policy_violation"}')))
      .toBe(SPAWN_FAILURE_CLASS.CONTENT_REFUSED);
  });
});
