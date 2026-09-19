// TASK-063: the server-side confinement predicate for a grant broker. The
// table is the point of this file — each row is a declaration the server may
// see, and the two rows that must NOT refuse are the ones that keep the fix
// from breaking a working seat (a public trust with no declared mode, which
// #1754's daemon derives per host, and an ABSENT sandbox block, which is the
// normal state of a daemon-provisioned seat).
const {
  LEGACY_SANDBOX_TRUST,
  GRANT_BROKER_REFUSAL_CODE,
  CONFINEMENTLESS_ADAPTERS,
  PUBLIC_HOST_MODES,
  effectiveSandboxTrust,
  normalizeAdapter,
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

  // The adapter and mode sets are the host-independent half of the enforcing
  // layers' rule, so pin their membership: widening either one silently starts
  // refusing seats a host would have confined.
  it('pins the host-independent sets to what the adapters implement', () => {
    expect([...CONFINEMENTLESS_ADAPTERS]).toEqual(['pi']);
    expect([...PUBLIC_HOST_MODES].sort()).toEqual(['bwrap', 'read-only', 'workspace']);
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

  // The adapter is a host-independent fact: pi's assertNoSandboxDeclared
  // (cli/src/lib/adapters/pi.js) throws only when a sandbox is DECLARED, so a
  // pi seat that declares nothing spawns unconfined and nothing ever derives
  // one. The adapter decides, which is why it is checked before the
  // declaration — a pi seat is refused whether or not it declares a sandbox.
  it.each([
    ['a pi seat with no sandbox block', undefined, { adapter: 'pi' }, 'adapter_cannot_confine'],
    ['a pi seat declaring a confined mode', { sandbox: { mode: 'workspace', trust: 'public' } }, { adapter: 'pi' }, 'adapter_cannot_confine'],
    ['a pi seat with no environment at all', undefined, { adapter: 'pi' }, 'adapter_cannot_confine'],
    ['a claude seat with no sandbox block — the daemon derives the baseline', undefined, { adapter: 'claude' }, null],
    ['a codex seat declaring a confined mode', { sandbox: { mode: 'read-only', trust: 'public' } }, { adapter: 'codex' }, null],
    ['a row that names no adapter — the daemon detects it locally', undefined, { model: 'gpt-5.4' }, null],
    ['a row with no runtime at all', undefined, undefined, null],
    // The daemon normalises the declared adapter before it spawns
    // (`daemon-supervisor.js` does `trim().toLowerCase()`), so these names still
    // reach pi; comparing the raw value let both past the refusal (Vera 69817).
    ['an upper-case adapter name', undefined, { adapter: 'PI' }, 'adapter_cannot_confine'],
    ['a padded adapter name', undefined, { adapter: ' pi ' }, 'adapter_cannot_confine'],
    ['a padded upper-case adapter name', undefined, { adapter: 'PI ' }, 'adapter_cannot_confine'],
    ['a normalised name that is not pi', undefined, { adapter: ' claude ' }, null],
  ])('decides %s', (_label, environment, runtime, expected) => {
    const refusal = grantBrokerRefusal(environment, runtime);
    if (expected === null) {
      expect(refusal).toBeNull();
      return;
    }
    expect(refusal).toMatchObject({ code: GRANT_BROKER_REFUSAL_CODE, decidedBy: 'server', reason: expected });
    // The remedy names the thing to change: the adapter, not the sandbox.
    expect(refusal.detail).toContain('adapter');
  });

  // The write-time schema (environment.js ALLOWED_SANDBOX_MODES) accepts modes
  // no adapter implements — firejail, container and managed appear nowhere else
  // in cli/src — so a public seat declaring one confines on no host, on main's
  // CLI or #1754's. `bwrap` is the exception that keeps this from being a
  // second enforcement definition: claude implements it on Linux.
  it.each([
    ['a mode no adapter implements', { sandbox: { mode: 'firejail', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['another unenforced mode', { sandbox: { mode: 'container', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a managed mode', { sandbox: { mode: 'managed', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a typo of a real mode', { sandbox: { mode: 'workspaces', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a non-string mode', { sandbox: { mode: 42, trust: 'public' } }, 'sandbox_mode_unenforceable'],
    // `String(['bwrap'])` is 'bwrap', so the array passed a string-coerced
    // membership test while every adapter's `===` comparison rejected it — the
    // seat confined nowhere (Vera 69817).
    ['an array whose stringification is a real mode', { sandbox: { mode: ['bwrap'], trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['an object mode', { sandbox: { mode: { toString: () => 'workspace' }, trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a boolean mode', { sandbox: { mode: true, trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['an empty-string mode', { sandbox: { mode: '', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a legacy internal trust beside an unenforced mode', { sandbox: { mode: 'firejail', trust: 'internal' } }, 'sandbox_mode_unenforceable'],
    ['bwrap, which claude implements on Linux', { sandbox: { mode: 'bwrap', trust: 'public' } }, null],
  ])('decides %s', (_label, environment, expected) => {
    const refusal = grantBrokerRefusal(environment);
    if (expected === null) {
      expect(refusal).toBeNull();
      return;
    }
    expect(refusal).toMatchObject({ code: GRANT_BROKER_REFUSAL_CODE, decidedBy: 'server', reason: expected });
    expect(refusal.detail).toContain('sandbox.mode');
  });

  // The adapter name is only meaningful after the daemon's normalisation, so
  // pin the normalisation itself rather than the membership test alone.
  it('normalises an adapter name the way the daemon does', () => {
    expect(normalizeAdapter('PI')).toBe('pi');
    expect(normalizeAdapter(' pi ')).toBe('pi');
    expect(normalizeAdapter('Claude')).toBe('claude');
    expect(normalizeAdapter('')).toBeNull();
    expect(normalizeAdapter('   ')).toBeNull();
    expect(normalizeAdapter(42)).toBeNull();
    expect(normalizeAdapter(null)).toBeNull();
    expect(normalizeAdapter(undefined)).toBeNull();
  });
});
