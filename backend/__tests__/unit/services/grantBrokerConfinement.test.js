// TASK-063: the server-side confinement predicate for a grant broker. The
// table is the point of this file — each row is a declaration the server may
// see, and the two rows that must NOT refuse are the ones that keep the fix
// from breaking a working seat (a public trust with no declared mode, which
// #1754's daemon derives per host, and an ABSENT sandbox block, which is the
// normal state of a daemon-provisioned seat).
const {
  LEGACY_SANDBOX_TRUST,
  GRANT_BROKER_REFUSAL_CODE,
  CONFINING_ADAPTERS,
  PUBLIC_ONLY_GRANT_ADAPTERS,
  PUBLIC_ONLY_REASON,
  RUNTIME_KINDS,
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
    // 2026-10-09: the denylist became an allowlist of adapters that prove they confine,
    // keyed to the modes each enforces. An adapter is refused because it is absent, not listed.
    expect([...CONFINING_ADAPTERS.keys()].sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect([...CONFINING_ADAPTERS.get('claude')].sort()).toEqual(['bwrap', 'read-only', 'workspace']);
    expect([...CONFINING_ADAPTERS.get('codex')].sort()).toEqual(['read-only', 'workspace']);
    // F175a: OpenCode enforces Seatbelt workspace/read-only on macOS and bwrap
    // on Linux (cli adapters/opencode.js refuses a public seat on any other).
    expect([...CONFINING_ADAPTERS.get('opencode')].sort()).toEqual(['bwrap', 'read-only', 'workspace']);
    // F175c: pi confines only a public seat, in macOS Seatbelt (no bwrap path).
    expect([...CONFINING_ADAPTERS.get('pi')].sort()).toEqual(['read-only', 'workspace']);
    expect([...PUBLIC_ONLY_GRANT_ADAPTERS]).toEqual(['pi']);
    expect(PUBLIC_ONLY_REASON).toBe('adapter_confines_public_only');
    for (const unconfined of ['dsh', 'hermes', 'goose', 'qwen']) expect(CONFINING_ADAPTERS.has(unconfined)).toBe(false);
    // Mirror of CLOUD_RUNTIME_TYPES + the BYO kinds + what install paths write;
    // runtimeType values outside this set are adapter-shaped and judged.
    expect([...RUNTIME_KINDS].sort()).toEqual([
      'claude-code', 'hosted', 'internal', 'local-cli', 'managed-agents', 'moltbot', 'native', 'webhook', 'wrapper',
    ]);
    expect(RUNTIME_KINDS.has('pi')).toBe(false);
    expect(RUNTIME_KINDS.has('opencode')).toBe(false);
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
      'a legacy internal trust with no declared mode — the mapping is the only gate',
      { sandbox: { trust: 'internal' } },
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

  // Every other `internal` case in this suite pairs the mapping with a mode, so
  // a mode check carries the assertion on its own. With NO mode declared the
  // mapping is the only gate on the record: `internal` must read as `public`
  // (LEGACY_SANDBOX_TRUST) or a seat the daemon will confine loses the broker.
  // It is the easiest part of the predicate to break silently, which is why it
  // is asserted on its own rather than left to the table row.
  it('lets a legacy internal trust through when it is the only thing declared', () => {
    expect(grantBrokerRefusal({ sandbox: { trust: 'internal' } })).toBeNull();
    // The neighbouring shape must keep failing, so the assertion above cannot
    // be satisfied by dropping the trust check altogether.
    expect(grantBrokerRefusal({ sandbox: { trust: 'private' } }))
      .toMatchObject({ reason: 'sandbox_trust_not_public' });
  });

  // The adapter is a host-independent fact. pi (F175c) is confined only on a
  // declared public seat and is never handed a default sandbox, so a pi seat
  // that declares nothing spawns unconfined: for pi an absent block is a
  // refusal, and every pi refusal is the one naming does not lift.
  it.each([
    ['a pi seat with no sandbox block', undefined, { adapter: 'pi' }, 'adapter_confines_public_only'],
    ['a pi seat with no environment at all', undefined, { adapter: 'pi' }, 'adapter_confines_public_only'],
    ['a private pi seat', { sandbox: { trust: 'private' } }, { adapter: 'pi' }, 'adapter_confines_public_only'],
    ['a pi seat with mode none', { sandbox: { mode: 'none', trust: 'public' } }, { adapter: 'pi' }, 'adapter_confines_public_only'],
    ['a pi seat declaring bwrap, which pi does not implement', { sandbox: { mode: 'bwrap', trust: 'public' } }, { adapter: 'pi' }, 'adapter_confines_public_only'],
    ['a public pi seat with no mode — the host resolves it', { sandbox: { trust: 'public' } }, { adapter: 'pi' }, null],
    ['a public pi workspace seat', { sandbox: { mode: 'workspace', trust: 'public' } }, { adapter: 'pi' }, null],
    ['a public pi read-only seat', { sandbox: { mode: 'read-only', trust: 'public' } }, { adapter: 'pi' }, null],
    ['a legacy internal trust on pi', { sandbox: { trust: 'internal' } }, { adapter: 'pi' }, null],
    ['a goose seat, which is not on the grant list', { sandbox: { mode: 'workspace', trust: 'public' } }, { adapter: 'goose' }, 'adapter_cannot_confine'],
    // F175a: OpenCode is admitted on its three modes and nowhere else.
    ['an OpenCode seat with no sandbox block — the daemon derives the baseline', undefined, { adapter: 'opencode' }, null],
    ['an OpenCode workspace seat', { sandbox: { mode: 'workspace', trust: 'public' } }, { adapter: 'opencode' }, null],
    ['an OpenCode read-only seat', { sandbox: { mode: 'read-only', trust: 'public' } }, { adapter: 'opencode' }, null],
    ['an OpenCode bwrap seat', { sandbox: { mode: 'bwrap', trust: 'public' } }, { adapter: 'opencode' }, null],
    ['an OpenCode runtimeType without explicit adapter', { sandbox: { mode: 'workspace', trust: 'public' } }, { runtimeType: 'opencode', host: 'byo' }, null],
    ['a dsh seat, which runs no sandbox', { sandbox: { mode: 'workspace', trust: 'public' } }, { adapter: 'dsh' }, 'adapter_cannot_confine'],
    ['a hermes seat, which runs no sandbox', { sandbox: { mode: 'workspace', trust: 'public' } }, { adapter: 'hermes' }, 'adapter_cannot_confine'],
    ['a claude seat with no sandbox block — the daemon derives the baseline', undefined, { adapter: 'claude' }, null],
    ['a codex seat declaring a confined mode', { sandbox: { mode: 'read-only', trust: 'public' } }, { adapter: 'codex' }, null],
    ['a row that names no adapter — the daemon detects it locally', undefined, { model: 'gpt-5.4' }, null],
    ['a row with no runtime at all', undefined, undefined, null],
    // The daemon normalises the declared adapter before it spawns
    // (`daemon-supervisor.js` does `trim().toLowerCase()`), so these names still
    // reach pi; comparing the raw value let both past the refusal (Vera 69817).
    ['an upper-case adapter name', undefined, { adapter: 'PI' }, 'adapter_confines_public_only'],
    ['a padded adapter name', undefined, { adapter: ' pi ' }, 'adapter_confines_public_only'],
    ['a padded upper-case adapter name', undefined, { adapter: 'PI ' }, 'adapter_confines_public_only'],
    ['a normalised name that is not pi', undefined, { adapter: ' claude ' }, null],
    // TASK-175: the adapter is `runtime.adapter` OR `runtime.runtimeType`. A
    // hand-attached pi seat writes {runtimeType: 'pi', host: 'byo'} and no
    // adapter key (cli/src/commands/agent.js:664, :688), so reading `adapter`
    // alone admitted exactly the seat this rule exists to refuse.
    ['a pi seat tagged only by runtimeType (the hand-attached shape)', undefined, { runtimeType: 'pi', host: 'byo' }, 'adapter_confines_public_only'],
    ['a pi runtimeType in another case', undefined, { runtimeType: 'PI' }, 'adapter_confines_public_only'],
    ['a codex seat tagged only by runtimeType remains broker-confined', { sandbox: { mode: 'workspace', trust: 'public' } }, { runtimeType: 'codex', host: 'byo' }, null],
    ['a declared adapter wins over a pi runtimeType, as it does in the daemon', undefined, { adapter: 'claude', runtimeType: 'pi', host: 'byo' }, null],
    ['a claude-code runtimeType', undefined, { runtimeType: 'claude-code', host: 'byo' }, null],
    ['a webhook connect-page seat', undefined, { runtimeType: 'webhook', host: 'byo' }, null],
    // The arm that rejects "refuse anything without an adapter": undeclared, the
    // daemon resolves only claude or codex (cli/src/commands/daemon.js:142), so
    // failing closed here would refuse working claude seats.
    ['a row naming neither adapter nor runtimeType', undefined, { host: 'byo' }, null],
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

  // F175a: an admitted OpenCode seat is still judged on its declaration, the
  // same way claude is: admission is per mode, never a blanket pass.
  it.each([
    ['mode none', { sandbox: { mode: 'none', trust: 'public' } }, 'sandbox_mode_none'],
    ['a mode it does not enforce', { sandbox: { mode: 'firejail', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a private trust', { sandbox: { mode: 'workspace', trust: 'private' } }, 'sandbox_trust_not_public'],
  ])('refuses an OpenCode seat on %s', (_label, environment, expected) => {
    expect(grantBrokerRefusal(environment, { adapter: 'opencode' }))
      .toMatchObject({ code: GRANT_BROKER_REFUSAL_CODE, decidedBy: 'server', reason: expected });
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

// #3458 review: `sandbox_absent` is for a seat that runs on someone's own
// machine with no daemon. A runtime Commonly runs keeps the old reading.
describe('grantBrokerRefusalWithoutDaemon — only a BYO seat has an absent sandbox refused', () => {
  // eslint-disable-next-line global-require
  const confinement = require('../../../services/grantBrokerConfinement');
  // eslint-disable-next-line global-require
  const { CLOUD_RUNTIME_TYPES, isCloudRuntime } = require('../../../services/agentIdentityService');
  // eslint-disable-next-line global-require
  const { KERNEL_RUN_RUNTIME_TYPES } = require('../../../services/configWriteGuard');

  it('mirrors the cloud and kernel-run runtime sets (the module stays a leaf)', () => {
    expect([...confinement.COMMONLY_RUN_RUNTIME_TYPES].sort())
      .toEqual([...new Set([...CLOUD_RUNTIME_TYPES, ...KERNEL_RUN_RUNTIME_TYPES])].sort());
  });

  it.each([
    [{ runtimeType: 'native' }],
    [{ runtimeType: 'moltbot' }],
    [{ runtimeType: 'internal' }],
    [{ runtimeType: 'managed-agents' }],
    [{ runtimeType: 'hosted' }],
    [{ runtimeType: 'native', host: 'byo' }],
    [{ runtimeType: 'codex' }],
  ])('a runtime Commonly runs (%j) keeps the old reading', (runtime) => {
    expect(confinement.runsOnCommonly(runtime)).toBe(true);
    expect(confinement.grantBrokerRefusalWithoutDaemon(undefined, runtime)).toBeNull();
    expect(confinement.grantBrokerRefusalWithoutDaemon({ model: 'x' }, runtime)).toBeNull();
  });

  // #3458 re-review (MEDIUM): CLI attach writes `adapter` on every BYO row, and
  // a Settings harness switch used to drop `host`. A codex row that names an
  // adapter is a seat on someone's machine; only one with `host: 'cloud'`, or
  // with neither host nor adapter (what the registry install of cloud-codex
  // writes), is Commonly's.
  it.each([
    [{ runtimeType: 'codex', adapter: 'codex' }, false],
    [{ runtimeType: 'codex', adapter: 'claude' }, false],
    [{ runtimeType: 'codex', adapter: 'codex', host: 'byo' }, false],
    [{ runtimeType: 'codex', host: 'byo' }, false],
    [{ runtimeType: 'codex', host: 'cloud' }, true],
    [{ runtimeType: 'codex', host: 'cloud', adapter: 'codex' }, true],
    [{ runtimeType: 'codex' }, true],
  ])('a codex row %j runs on Commonly: %s', (runtime, expected) => {
    expect(confinement.runsOnCommonly(runtime)).toBe(expected);
    const refusal = confinement.grantBrokerRefusalWithoutDaemon(undefined, runtime);
    if (expected) expect(refusal).toBeNull();
    else expect(refusal).toMatchObject({ reason: 'sandbox_absent' });
  });

  it('agrees with isCloudRuntime on the cloud set', () => {
    [...CLOUD_RUNTIME_TYPES].forEach((runtimeType) => {
      expect(confinement.runsOnCommonly({ runtimeType })).toBe(isCloudRuntime({ runtimeType }));
    });
  });

  it.each([
    [undefined],
    [{ runtimeType: 'webhook' }],
    [{ runtimeType: 'webhook', host: 'byo' }],
    [{ runtimeType: 'claude-code' }],
    [{ adapter: 'claude', host: 'byo' }],
    [{ runtimeType: 'wrapper', adapter: 'codex' }],
    [{ runtimeType: 'codex', host: 'byo' }],
  ])('a BYO row (%j) with no sandbox block is refused as sandbox_absent', (runtime) => {
    expect(confinement.runsOnCommonly(runtime)).toBe(false);
    expect(confinement.grantBrokerRefusalWithoutDaemon(undefined, runtime))
      .toMatchObject({ code: GRANT_BROKER_REFUSAL_CODE, reason: 'sandbox_absent' });
  });
});
