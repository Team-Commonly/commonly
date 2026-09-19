// TASK-063: the server-side confinement predicate for a grant broker. The
// table is the point of this file — each row is a declaration the server may
// see, and the two rows that must NOT refuse are the ones that keep the fix
// from breaking a working seat (a public trust with no declared mode, which
// #1754's daemon derives per host, and an ABSENT sandbox block, which is the
// normal state of a daemon-provisioned seat).
const {
  LEGACY_SANDBOX_TRUST,
  GRANT_BROKER_REFUSAL_CODE,
  effectiveSandboxTrust,
  grantBrokerRefusal,
} = require('../../../services/grantBrokerConfinement');

describe('grant broker confinement predicate', () => {
  // The cli owns this table (cli/src/lib/environment.js LEGACY_SANDBOX_TRUST);
  // the backend cannot import it, so the mirror is asserted rather than
  // assumed — a stored `internal` must read as `public`, never toward a bare
  // spawn.
  it('mirrors the cli legacy trust table exactly', () => {
    expect(LEGACY_SANDBOX_TRUST).toEqual({ internal: 'public' });
    expect(effectiveSandboxTrust('internal')).toBe('public');
    expect(effectiveSandboxTrust('public')).toBe('public');
    expect(effectiveSandboxTrust(undefined)).toBeUndefined();
    expect(effectiveSandboxTrust('Internal')).toBe('Internal');
  });

  it.each([
    ['no environment at all', undefined, null],
    ['an environment without a sandbox block', { model: 'gpt-5.4', mcp: [] }, null],
    ['an explicit null sandbox', { sandbox: null }, null],
    ['a sandbox that is not an object', { sandbox: [] }, null],
    ['a confined workspace', { sandbox: { mode: 'workspace', trust: 'public' } }, null],
    ['a confined read-only seat', { sandbox: { mode: 'read-only', trust: 'public' } }, null],
    ['a legacy internal trust, which reads as public', { sandbox: { mode: 'workspace', trust: 'internal' } }, null],
    [
      'a public trust with no declared mode — the daemon derives the mode per host',
      { sandbox: { trust: 'public' } },
      null,
    ],
    [
      'a confined seat carrying network and filesystem policy',
      { sandbox: { mode: 'workspace', trust: 'public', network: { policy: 'restricted' }, filesystem: { 'write-outside': [] } } },
      null,
    ],
    ['mode none', { sandbox: { mode: 'none', trust: 'public' } }, 'sandbox_mode_none'],
    ['mode none with no trust', { sandbox: { mode: 'none' } }, 'sandbox_mode_none'],
    ['a non-public trust', { sandbox: { mode: 'workspace', trust: 'private' } }, 'sandbox_trust_not_public'],
    ['an absent trust beside a declared mode', { sandbox: { mode: 'workspace' } }, 'sandbox_trust_not_public'],
    ['a policy-only sandbox block', { sandbox: { network: { policy: 'restricted' } } }, 'sandbox_trust_not_public'],
    ['a case variant of the legacy trust', { sandbox: { mode: 'workspace', trust: 'Internal' } }, 'sandbox_trust_not_public'],
  ])('decides %s', (_label, environment, expected) => {
    const refusal = grantBrokerRefusal(environment);
    if (expected === null) {
      expect(refusal).toBeNull();
      return;
    }
    expect(refusal).toMatchObject({
      code: GRANT_BROKER_REFUSAL_CODE,
      decidedBy: 'server',
      reason: expected,
    });
    // The detail has to name the declaration to change: the remedy is the same
    // whether the server or the daemon refused.
    expect(typeof refusal.detail).toBe('string');
    expect(refusal.detail).toMatch(/sandbox\.(mode|trust)/);
  });

  it('names the observed trust value in the detail', () => {
    expect(grantBrokerRefusal({ sandbox: { mode: 'workspace' } }).detail).toContain('absent');
    expect(grantBrokerRefusal({ sandbox: { mode: 'workspace', trust: 'private' } }).detail)
      .toContain("'private'");
  });
});
