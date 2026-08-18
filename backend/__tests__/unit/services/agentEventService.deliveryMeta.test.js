/**
 * `delivery.details` is a load-bearing channel with no test behind it.
 *
 * `normalizeDeliveryMeta` whitelists `outcome`, `reason` and `messageId`, and
 * passes `details` through as an opaque object into a `Schema.Types.Mixed`
 * field. That pass-through is what lets a wrapper attach structured context to
 * an ack without a schema migration — #981 uses it to record which cascade
 * settings produced a refusal, so "which cap did this seat run" is answerable
 * from the rows rather than from a boot log nobody keeps.
 *
 * Nothing exercised it. A well-meaning tightening of this function to a strict
 * whitelist would drop `details` silently: the ack still succeeds, the row
 * still persists, every suite stays green, and the instrument goes dark. That
 * is the failure mode this file exists to make loud.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const AgentEventService = require('../../../services/agentEventService');

describe('normalizeDeliveryMeta — the details channel', () => {
  test('passes an arbitrary details object through untouched', () => {
    const details = {
      streak: 3, cap: 8, addressedGrace: 0, resetMs: 600000, nested: { a: [1, 2] },
    };
    const meta = AgentEventService.normalizeDeliveryMeta({
      outcome: 'no_action', reason: 'cascade-cap', details,
    });

    expect(meta.details).toEqual(details);
    // Not merely equal — the whitelist must not rebuild it key by key, or a
    // field added by a caller tomorrow is dropped by a function written today.
    expect(meta.details).toBe(details);
  });

  test('keeps the fields the ack path depends on alongside it', () => {
    const meta = AgentEventService.normalizeDeliveryMeta({
      outcome: 'no_action', reason: 'cascade-cap', details: { cap: 8 },
    });
    // `reason` is matched with === by the wrapper's stand-down gate, so it has
    // to survive verbatim rather than being normalised like `outcome` is.
    expect(meta.reason).toBe('cascade-cap');
    expect(meta.outcome).toBe('no_action');
    expect(meta.details.cap).toBe(8);
  });

  test('a non-object details is dropped, and the drop is selective', () => {
    // The guard that makes the pass-through safe. Without it, `details: "x"`
    // reaches a Mixed field and every reader has to defend against a string.
    expect(AgentEventService.normalizeDeliveryMeta({ details: 'nope' }).details)
      .toBeUndefined();
    expect(AgentEventService.normalizeDeliveryMeta({ details: 7 }).details)
      .toBeUndefined();
    // Paired positive control, in this test rather than trusting the ones
    // above: an assertion that something is dropped is satisfied by a version
    // that drops everything, which is precisely the regression this file is
    // here to catch. Asserting the selectivity is what makes it a guard.
    expect(AgentEventService.normalizeDeliveryMeta({ details: { ok: true } }).details)
      .toEqual({ ok: true });
  });

  test('an unrecognised outcome falls back rather than reaching the enum', () => {
    // Control: this function DOES normalise, so the pass-through above is a
    // deliberate exception and not an absence of validation. A version that
    // validated nothing would satisfy the details tests and fail this one.
    expect(AgentEventService.normalizeDeliveryMeta({ outcome: 'exploded' }).outcome)
      .toBe('acknowledged');
  });
});
