/**
 * claimReleaseFor — the one decision about how a finished turn releases its
 * ADR-018 claim (TASK-099).
 *
 * Tested as a unit because both release sites (single-event and batch) now
 * share it, and because the batch path is the one `message.posted` actually
 * reaches: a rule proven only at the single-event site proves nothing about
 * what a chat mention does.
 *
 * What is asserted here is the OUTCOME and its CLASS. What the kernel then does
 * with a refusal (hand a human wake on, close an agent wake) is the kernel's
 * routing, tested against the handoff service and the release route — not
 * something this function is allowed to pre-empt by guessing.
 */
import { describe, expect, test } from '@jest/globals';

import {
  claimReleaseFor, ackResultFor, REFUSAL_REASONS,
  MIN_UPSTREAM_STATUS, MAX_UPSTREAM_STATUS,
} from '../src/lib/claim-outcome.js';

const humanBroadcast = { type: 'message.posted', payload: { senderIsHuman: true } };
const agentMention = { type: 'chat.mention', payload: {} };

describe('claimReleaseFor', () => {
  test('an upstream refusal releases as its class plus the HTTP status', () => {
    // The class is what makes refusals countable per cause; the status is the
    // instance. The human-readable text (`upstream-refused-429`) stays in the
    // seat log and the event ack — it is not the kernel's record.
    expect(claimReleaseFor(agentMention, {
      outcome: 'no_action',
      refused: { reason: 'upstream-refused', status: 429 },
      reason: 'upstream-refused-429',
    })).toEqual({ outcome: 'refused', reason: 'upstream-refused', status: 429 });
  });

  test('an upstream refusal with no usable status still carries its class', () => {
    // The adapter reports null when the error text had no 4xx/5xx prefix. A
    // missing status must not turn a named refusal into an unnamed one, and it
    // must not become the string "null" or a zero either.
    expect(claimReleaseFor(agentMention, {
      outcome: 'no_action', refused: { reason: 'upstream-refused' },
    })).toEqual({ outcome: 'refused', reason: 'upstream-refused' });
    const release = claimReleaseFor(agentMention, {
      outcome: 'no_action', refused: { reason: 'upstream-refused', status: null },
    });
    expect('status' in release).toBe(false);
  });

  test('the kernel\'s status range is mirrored, at both bounds', () => {
    // Pinned as literals rather than read from the constants: a test that asks
    // the constant what the constant should be cannot fail when it changes.
    // The kernel's `MIN_UPSTREAM_STATUS`/`MAX_UPSTREAM_STATUS` are 400 and 599,
    // and this is the sender's half of that contract.
    expect([MIN_UPSTREAM_STATUS, MAX_UPSTREAM_STATUS]).toEqual([400, 599]);
  });

  test('the bounds are inclusive: 400 and 599 are forwarded', () => {
    expect(claimReleaseFor(agentMention, {
      outcome: 'no_action', refused: { reason: 'upstream-refused', status: 400 },
    })).toEqual({ outcome: 'refused', reason: 'upstream-refused', status: 400 });
    expect(claimReleaseFor(agentMention, {
      outcome: 'no_action', refused: { reason: 'upstream-refused', status: 599 },
    })).toEqual({ outcome: 'refused', reason: 'upstream-refused', status: 599 });
  });

  test('an out-of-range status keeps the class and drops the number', () => {
    // The kernel refuses a status outside 400-599 with a 400, and the 400
    // fallback re-releases as `completed` — terminal, so the refusal would lose
    // its handoff entirely. Dropping the number alone keeps the handoff: the
    // turn is still recorded as an upstream refusal, which is the part a human
    // wake is routed on.
    for (const status of [200, 399, 600, 0, 1000]) {
      const release = claimReleaseFor(agentMention, {
        outcome: 'no_action', refused: { reason: 'upstream-refused', status },
      });
      expect(release).toEqual({ outcome: 'refused', reason: 'upstream-refused' });
      expect('status' in release).toBe(false);
    }
  });

  test('the cap refusal is a refusal, and carries no status', () => {
    // An admitted turn dropped by the seat's own governor is a refusal of the
    // same sentence — something outside the agent's choice stopped delivery —
    // and it is not rare (73 cap refusals against 2 posts in one sampled seat
    // log), which is exactly why the class has to be distinguishable.
    expect(claimReleaseFor(humanBroadcast, {
      outcome: 'no_action', refused: { reason: 'cascade-cap' }, reason: 'cascade-cap',
    })).toEqual({ outcome: 'refused', reason: 'cascade-cap' });
  });

  test('a status sent with a class that cannot have one is dropped', () => {
    // Only the upstream class saw an HTTP response. Recording a status beside
    // `delivery-refused` would put a number on the record that a reader would
    // reasonably read as the upstream answer.
    expect(claimReleaseFor(agentMention, {
      outcome: 'no_action', refused: { reason: 'delivery-refused', status: 429 },
    })).toEqual({ outcome: 'refused', reason: 'delivery-refused' });
  });

  test('an unrecognised class becomes delivery-refused, not a fourth class', () => {
    // The kernel validates the enum and 400s anything else, so an unmapped
    // value here would fail the release outright. The class that claims the
    // least is the honest floor.
    expect(claimReleaseFor(agentMention, {
      outcome: 'no_action', refused: { reason: 'run-cap' },
    })).toEqual({ outcome: 'refused', reason: 'delivery-refused' });
  });

  test('a bare `refused: true` from an older producer still names a class', () => {
    // The marker shipped in #1828 and in TASK-096's docs as a boolean. It means
    // the same thing — the holder could not deliver — so it maps to the floor
    // class rather than falling through to `completed`.
    expect(claimReleaseFor(agentMention, { outcome: 'no_action', refused: true }))
      .toEqual({ outcome: 'refused', reason: 'delivery-refused' });
  });

  test('a refusal on a silent human broadcast is still a refusal, not a decline', () => {
    // The discriminating input: a refusal with NO free-text reason. Classifying
    // it as `declined` would tell the kernel "the agent chose not to answer"
    // and hand a seat-local outage to the next listener as if the agent had
    // passed — the two outcomes the kernel now treats differently in opposite
    // directions, wearing each other's name.
    expect(claimReleaseFor(humanBroadcast, {
      outcome: 'no_action', refused: { reason: 'cascade-cap' },
    })).toEqual({ outcome: 'refused', reason: 'cascade-cap' });
  });

  test('the class name alone does not make a turn a refusal', () => {
    // The producer marks; nothing pattern-matches a reason string. A skip whose
    // reason happens to read `cascade-cap` (or an upstream-shaped string) is
    // still a skip, and a refusal label here would be a false kernel record.
    expect(claimReleaseFor(humanBroadcast, { outcome: 'no_action', reason: 'cascade-cap' }))
      .toEqual({ outcome: 'completed' });
    expect(claimReleaseFor(humanBroadcast, { outcome: 'no_action', reason: 'upstream-refused' }))
      .toEqual({ outcome: 'completed' });
  });

  test('a silent human broadcast with no reason still declines', () => {
    expect(claimReleaseFor(humanBroadcast, { outcome: 'no_action' })).toEqual({ outcome: 'declined' });
  });

  test('a skip that is not a refusal completes — the paired control', () => {
    // `claim-held` and `duplicate-delivery` carry a reason but nothing was
    // refused.
    expect(claimReleaseFor(humanBroadcast, { outcome: 'no_action', reason: 'claim-held' }))
      .toEqual({ outcome: 'completed' });
    expect(claimReleaseFor(agentMention, { outcome: 'no_action', reason: 'duplicate-delivery' }))
      .toEqual({ outcome: 'completed' });
  });

  test('a posted reply completes', () => {
    expect(claimReleaseFor(agentMention, { outcome: 'posted' })).toEqual({ outcome: 'completed' });
  });

  test('a thrown turn keeps the legacy release', () => {
    // No turnResult: the spawn died. The holder-only DELETE leaves the message
    // re-deliverable, which is the correct at-least-once behaviour.
    expect(claimReleaseFor(agentMention, undefined)).toEqual({ outcome: undefined });
  });

  test('the exported enum is the kernel\'s vocabulary, in one place', () => {
    // Pinned as a literal: the route validates against its own copy, so a
    // divergence here is a silent 400 on every refusal from a shipped CLI.
    expect([...REFUSAL_REASONS].sort()).toEqual(['cascade-cap', 'delivery-refused', 'upstream-refused']);
  });
});

describe('ackResultFor', () => {
  test('drops the local release marker from the event ack', () => {
    // The ack is a wire payload; the marker is ours. `reason` already carries
    // the same information to every reader of the ack.
    expect(ackResultFor({
      outcome: 'no_action',
      refused: { reason: 'upstream-refused', status: 429 },
      reason: 'upstream-refused-429',
      details: { status: 429 },
    })).toEqual({
      outcome: 'no_action', reason: 'upstream-refused-429', details: { status: 429 },
    });
  });

  test('drops the boolean marker an older shape leaves too', () => {
    expect(ackResultFor({ outcome: 'no_action', refused: true, reason: 'x' }))
      .toEqual({ outcome: 'no_action', reason: 'x' });
  });

  test('passes an ordinary result through untouched — same object', () => {
    const ordinary = { outcome: 'posted' };
    expect(ackResultFor(ordinary)).toBe(ordinary);
    const skipped = { outcome: 'no_action', reason: 'claim-held' };
    expect(ackResultFor(skipped)).toBe(skipped);
    expect(ackResultFor(undefined)).toBeUndefined();
  });
});
