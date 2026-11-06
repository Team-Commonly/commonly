// TASK-063, the daemon half: the grant broker is an entry that carries
// AUTHORITY, so a seat this daemon cannot confine must not start with it. The
// table below is the point of the file — each row is a declaration a local
// token record can hold, and the two ALLOW rows that matter are the working
// seat (a derived public baseline, `c4-smoke`'s shape) and every environment
// that declares no broker at all.
import { jest } from '@jest/globals';

import {
  GRANT_BROKER_REFUSAL_CODE,
  ENFORCING_MODES,
  isOurGrantBroker,
  declaresGrantBroker,
  confinementReason,
  withholdGrantBroker,
} from '../src/lib/grant-broker-guard.js';

const INSTANCE = 'https://api.commonly.me';
const BROKER_URL = '${COMMONLY_API_URL}/api/mcp/grants/grant_4df79b67-0f7f-481f-8cd6-9cd90b946bb7';
const broker = (over = {}) => ({
  name: 'commonly-grant-broker',
  transport: 'http',
  url: BROKER_URL,
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
  ...over,
});
const kernel = { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] };
const opts = { instanceUrl: INSTANCE };

describe('identifying the broker this daemon injects', () => {
  // The measured trap: the record holds the UNRESOLVED placeholder, and
  // `new URL()` throws on it — so a predicate reusing `isGrantBrokerUrl`
  // unchanged matches nothing here while reading as if it enforced something.
  test('matches the placeholder spelling the record actually holds', () => {
    expect(() => new URL(BROKER_URL)).toThrow(/Invalid URL/);
    expect(isOurGrantBroker(broker(), opts)).toBe(true);
  });

  test('matches the expanded spelling, and the relative one', () => {
    expect(isOurGrantBroker(broker({ url: `${INSTANCE}/api/mcp/grants/g1` }), opts)).toBe(true);
    expect(isOurGrantBroker(broker({ url: '/api/mcp/grants/g1' }), opts)).toBe(true);
  });

  // The control that keeps the predicate from being "any url with this path":
  // a foreign server is not our grant, so it is left to the adapters' own
  // origin rules rather than withheld by this layer.
  test('does not match another origin that merely shares the path', () => {
    expect(isOurGrantBroker(broker({ url: 'https://evil.example/api/mcp/grants/g1' }), opts)).toBe(false);
    expect(isOurGrantBroker(broker({ url: 'https://evil.example/api/mcp/grants/g1' }), { instanceUrl: INSTANCE })).toBe(false);
  });

  // vera 70369, the fail-open this predicate shipped with for one round: a
  // bound instance ending in a slash concatenates into
  // `https://api.commonly.me//api/mcp/grants/g1`, whose pathname starts `//api/`
  // and matches nothing — and a broker that is not recognised is a broker that
  // RIDES into a seat this daemon just decided it cannot confine. Reachable:
  // `agent.js` takes COMMONLY_API_URL with a bare `.trim()`.
  test.each([
    ['the clean instance', 'https://api.commonly.me'],
    ['a trailing slash', 'https://api.commonly.me/'],
    ['two trailing slashes', 'https://api.commonly.me//'],
    ['trailing whitespace after the slash', 'https://api.commonly.me/  '],
  ])('matches the injected placeholder however the instance is spelled: %s', (_label, instanceUrl) => {
    expect(isOurGrantBroker(broker(), { instanceUrl })).toBe(true);
  });

  test('a doubled slash inside the stored url is the same broker', () => {
    expect(isOurGrantBroker(broker({ url: `${INSTANCE}//api/mcp/grants/g1` }), opts)).toBe(true);
    expect(isOurGrantBroker(broker({ url: '//api/mcp/grants/g1' }), opts)).toBe(true);
  });

  // A schemeless url read BOTH ways (vera, 70372 corrected a draft that claimed
  // collapse alone covered this). Collapsing reads the first as the PATH
  // `/api.commonly.me/api/...` and misses it; URL semantics say the string names
  // THIS instance, so it is also resolved against the bound instance — otherwise
  // a hand-written record could smuggle our broker in with that spelling and a
  // miss is fail-open. A FOREIGN host gets no such reading.
  test('a protocol-relative url naming this instance is our broker, a foreign host is not', () => {
    expect(isOurGrantBroker(broker({ url: '//api.commonly.me/api/mcp/grants/g1' }), opts)).toBe(true);
    expect(isOurGrantBroker(broker({ url: '//evil.example/api/mcp/grants/g1' }), opts)).toBe(false);
    expect(isOurGrantBroker(broker({ url: '//api.commonly.me/api/mcp/grants/g1' }), {})).toBe(false);
  });

  // The normalizations are one-directional — a miss may become a match — so
  // this is the assertion that they cannot become a different origin's match.
  test('no spelling of the instance widens the ORIGIN check', () => {
    for (const instanceUrl of [INSTANCE, `${INSTANCE}/`, `${INSTANCE}//`]) {
      expect(isOurGrantBroker(broker({ url: 'https://evil.example//api/mcp/grants/g1' }), { instanceUrl })).toBe(false);
      expect(isOurGrantBroker(broker({ url: '${COMMONLY_API_URL}/api/mcp/grants/g1#frag' }), { instanceUrl })).toBe(true);
    }
  });

  test('does not match a non-broker entry, a missing url, or an unknown expansion', () => {
    expect(isOurGrantBroker(kernel, opts)).toBe(false);
    expect(isOurGrantBroker({ name: 'x', url: undefined }, opts)).toBe(false);
    expect(isOurGrantBroker(broker({ url: '${SOMETHING_ELSE}/api/mcp/grants/g1' }), opts)).toBe(false);
    expect(isOurGrantBroker(broker({ url: `${INSTANCE}/api/mcp/grants-archive/g1` }), opts)).toBe(false);
    // Without an instance to resolve against, no url can be shown to be ours —
    // including one that would match once the placeholder is expanded.
    expect(isOurGrantBroker(broker(), {})).toBe(false);
  });

  test('declaresGrantBroker is about the broker, not about mcp[] being non-empty', () => {
    expect(declaresGrantBroker({ mcp: [kernel] }, opts)).toBe(false);
    expect(declaresGrantBroker({ mcp: [kernel, broker()] }, opts)).toBe(true);
    expect(declaresGrantBroker({ mcp: [] }, opts)).toBe(false);
    expect(declaresGrantBroker(undefined, opts)).toBe(false);
  });
});

describe('grant-broker admission for this adapter', () => {
  test('pins the enforcing mode set to the modes an adapter implements', () => {
    // Derived from the cli's own PUBLIC_SANDBOX_MODES plus `bwrap`, which
    // `resolvePublicSandboxMode` resolves to on Linux — widening it silently
    // starts refusing seats a host would have confined.
    expect([...ENFORCING_MODES].sort()).toEqual(['bwrap', 'read-only', 'workspace']);
  });

  test.each([
    ['a derived public baseline — the working seat', 'claude', { sandbox: { trust: 'public' } }, null],
    ['the stored c4-smoke shape', 'claude', { sandbox: { mode: 'workspace', trust: 'public' } }, null],
    ['a legacy internal trust, which resolves toward confinement', 'claude', { sandbox: { mode: 'workspace', trust: 'internal' } }, null],
    // The mapping as the ONLY gate on the record: with no mode the legacy table
    // is all that stands between this seat and a withheld broker, and nothing
    // else in this table exercises that (Wren 71662).
    ['a legacy internal trust with no declared mode', 'claude', { sandbox: { trust: 'internal' } }, null],
    ['read-only for codex', 'codex', { sandbox: { mode: 'read-only', trust: 'public' } }, null],
    // F175a: OpenCode is admitted on the modes its adapter enforces for a
    // public seat (adapters/opencode.js refuses any other), and withheld on
    // every declaration that leaves it unconfined.
    ['OpenCode workspace', 'opencode', { sandbox: { mode: 'workspace', trust: 'public' } }, null],
    ['OpenCode read-only', 'opencode', { sandbox: { mode: 'read-only', trust: 'public' } }, null],
    ['OpenCode derived public baseline', 'opencode', { sandbox: { trust: 'public' } }, null],
    ['OpenCode without a sandbox declaration', 'opencode', {}, 'sandbox_absent'],
    ['OpenCode mode none', 'opencode', { sandbox: { mode: 'none', trust: 'public' } }, 'sandbox_mode_none'],
    ['OpenCode on a private trust', 'opencode', { sandbox: { mode: 'workspace', trust: 'private' } }, 'sandbox_trust_not_public'],
    ['OpenCode on a mode no adapter enforces', 'opencode', { sandbox: { mode: 'firejail', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['an OpenCode name in another case is the same adapter only once normalised', 'OpenCode', { sandbox: { trust: 'public' } }, 'adapter_cannot_confine'],
    ['dsh, which runs no sandbox', 'dsh', { sandbox: { trust: 'public' } }, 'adapter_cannot_confine'],
    ['hermes, which runs no sandbox', 'hermes', { sandbox: { trust: 'public' } }, 'adapter_cannot_confine'],
    ['an adapter this daemon cannot confine', 'mystery', { sandbox: { trust: 'public' } }, 'adapter_cannot_confine'],
    ['no adapter at all', null, { sandbox: { trust: 'public' } }, 'adapter_cannot_confine'],
    // The daemon-only reason: the SERVER must allow an absent block (a
    // daemon-provisioned seat\'s baseline is derived here, `quill` carries no
    // sandbox key), so absence is this layer\'s to judge. Reaching it means the
    // baseline did not supply one.
    ['no sandbox block at all', 'claude', { model: 'claude-opus-5' }, 'sandbox_absent'],
    ['a sandbox that is not an object', 'claude', { sandbox: [] }, 'sandbox_absent'],
    ['mode none', 'claude', { sandbox: { mode: 'none', trust: 'public' } }, 'sandbox_mode_none'],
    ['a non-public trust', 'claude', { sandbox: { mode: 'workspace', trust: 'private' } }, 'sandbox_trust_not_public'],
    ['an absent trust beside a declared mode', 'claude', { sandbox: { mode: 'workspace' } }, 'sandbox_trust_not_public'],
    ['a mode no adapter implements', 'claude', { sandbox: { mode: 'firejail', trust: 'public' } }, 'sandbox_mode_unenforceable'],
    ['a non-string mode', 'claude', { sandbox: { mode: ['bwrap'], trust: 'public' } }, 'sandbox_mode_unenforceable'],
  ])('%s', (_label, adapter, environment, expected) => {
    expect(confinementReason(environment, adapter)).toBe(expected);
  });

  test('resolves the mode by HOST, so the host is part of the answer', () => {
    // A public trust with no declared mode is the daemon-derived baseline: it is
    // confined because this host resolves a mode for it, on either platform.
    for (const platform of ['darwin', 'linux']) {
      expect(confinementReason({ sandbox: { trust: 'public' } }, 'claude', platform)).toBeNull();
    }
    expect(confinementReason({ sandbox: { mode: 'bwrap', trust: 'public' } }, 'codex', 'linux')).toBeNull();
  });

  // F175c: pi confines only a public seat, and only in the macOS Seatbelt
  // jail. Every pi declaration that leaves it unconfined gets the one reason
  // naming (F94) does not lift.
  test.each([
    ['a public pi seat on macOS', { sandbox: { trust: 'public' } }, 'darwin', null],
    ['a public pi seat, workspace mode', { sandbox: { mode: 'workspace', trust: 'public' } }, 'darwin', null],
    ['a public pi seat, read-only mode', { sandbox: { mode: 'read-only', trust: 'public' } }, 'darwin', null],
    ['a legacy internal trust on pi', { sandbox: { trust: 'internal' } }, 'darwin', null],
    ['a pi seat with no sandbox block (the private fleet shape)', {}, 'darwin', 'adapter_confines_public_only'],
    ['a private pi seat', { sandbox: { trust: 'private' } }, 'darwin', 'adapter_confines_public_only'],
    ['a pi seat with mode none', { sandbox: { mode: 'none', trust: 'public' } }, 'darwin', 'adapter_confines_public_only'],
    ['a public pi seat on Linux (pi has no bwrap path)', { sandbox: { trust: 'public' } }, 'linux', 'adapter_confines_public_only'],
    ['a public pi seat declaring workspace on Linux (Seatbelt is macOS-only)', { sandbox: { mode: 'workspace', trust: 'public' } }, 'linux', 'adapter_confines_public_only'],
    ['a pi seat declaring bwrap', { sandbox: { mode: 'bwrap', trust: 'public' } }, 'darwin', 'adapter_confines_public_only'],
    ['a public pi seat on native Windows', { sandbox: { trust: 'public' } }, 'win32', 'sandbox_mode_unenforceable'],
  ])('%s', (_label, environment, platform, expected) => {
    expect(confinementReason(environment, 'pi', platform)).toBe(expected);
  });

  // F175d: Qwen and Goose confine only a public seat too, but on both hosts:
  // Seatbelt on macOS and bubblewrap on Linux. A mode the host can't enforce
  // gets the same reason, and so does every seat that isn't public, because a
  // private seat on either runs with no jail at all.
  describe.each(['qwen', 'goose'])('%s holds a grant only as a public seat', (adapter) => {
    test.each([
      ['a public seat on macOS', { sandbox: { trust: 'public' } }, 'darwin', null],
      ['a public seat on Linux', { sandbox: { trust: 'public' } }, 'linux', null],
      ['workspace mode on macOS', { sandbox: { mode: 'workspace', trust: 'public' } }, 'darwin', null],
      ['read-only mode on macOS', { sandbox: { mode: 'read-only', trust: 'public' } }, 'darwin', null],
      ['bwrap mode on Linux', { sandbox: { mode: 'bwrap', trust: 'public' } }, 'linux', null],
      ['a legacy internal trust', { sandbox: { trust: 'internal' } }, 'darwin', null],
      ['no sandbox block', {}, 'darwin', 'adapter_confines_public_only'],
      ['a private seat', { sandbox: { trust: 'private' } }, 'darwin', 'adapter_confines_public_only'],
      ['a workspace-trust seat', { sandbox: { trust: 'workspace' } }, 'darwin', 'adapter_confines_public_only'],
      ['mode none', { sandbox: { mode: 'none', trust: 'public' } }, 'darwin', 'adapter_confines_public_only'],
      ['bwrap declared on macOS, which has none', { sandbox: { mode: 'bwrap', trust: 'public' } }, 'darwin', 'adapter_confines_public_only'],
      ['Seatbelt modes declared on Linux', { sandbox: { mode: 'workspace', trust: 'public' } }, 'linux', 'adapter_confines_public_only'],
      ['a mode no adapter implements', { sandbox: { mode: 'firejail', trust: 'public' } }, 'linux', 'adapter_confines_public_only'],
      ['native Windows', { sandbox: { trust: 'public' } }, 'win32', 'sandbox_mode_unenforceable'],
      ['a host with no rule', { sandbox: { trust: 'public' } }, 'freebsd', 'adapter_confines_public_only'],
    ])('%s', (_label, environment, platform, expected) => {
      expect(confinementReason(environment, adapter, platform)).toBe(expected);
    });

    test('a grant that names the seat does not ride a private one', () => {
      const named = { ...broker(), byoNamed: true };
      const environment = { sandbox: { trust: 'private' }, mcp: [named] };
      const out = withholdGrantBroker(environment, adapter, { ...opts, platform: 'darwin' });
      expect(out.mcp).toEqual([]);
    });

    test('the remedy names the sandbox on both hosts, not a Mac alone', () => {
      const onRefuse = jest.fn();
      withholdGrantBroker({ sandbox: { trust: 'private' }, mcp: [broker()] }, adapter, {
        ...opts, onRefuse, platform: 'linux',
      });
      const [refusal] = onRefuse.mock.calls[0];
      expect(refusal.detail).toContain("sandbox.trust 'public'");
      expect(refusal.detail).not.toMatch(/\bMac\b|macOS/);
    });
  });

  test('OpenCode is confined on macOS and Linux, and on no host on native Windows', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(confinementReason({ sandbox: { trust: 'public' } }, 'opencode', platform)).toBeNull();
    }
    expect(confinementReason({ sandbox: { mode: 'bwrap', trust: 'public' } }, 'opencode', 'linux')).toBeNull();
    expect(confinementReason({ sandbox: { trust: 'public' } }, 'opencode', 'win32')).toBe('sandbox_mode_unenforceable');
    expect(confinementReason({ sandbox: { mode: 'workspace', trust: 'public' } }, 'opencode', 'win32'))
      .toBe('sandbox_mode_unenforceable');
  });
});

describe('withholding the broker, entry-level', () => {
  const environment = { model: 'claude-opus-5', mcp: [kernel, broker()] };

  test('keeps every other entry and returns a new object', () => {
    const out = withholdGrantBroker(environment, 'dsh', opts);
    expect(out.mcp.map((s) => s.name)).toEqual(['commonly']);
    expect(out.model).toBe('claude-opus-5');
    expect(out).not.toBe(environment);
    // The declaration is not edited in place: the caller may still be holding
    // the row it came from.
    expect(environment.mcp).toHaveLength(2);
  });

  test('reports the same typed code the server emits, and which layer decided', () => {
    const onRefuse = jest.fn();
    withholdGrantBroker(environment, 'dsh', { ...opts, onRefuse });
    expect(onRefuse).toHaveBeenCalledTimes(1);
    const [refusal, names] = onRefuse.mock.calls[0];
    expect(refusal.code).toBe(GRANT_BROKER_REFUSAL_CODE);
    expect(refusal.code).toBe('grant_broker_unconfined');
    expect(refusal.decidedBy).toBe('daemon');
    expect(refusal.reason).toBe('adapter_cannot_confine');
    // The remedy names every adapter that can hold the broker, from the set.
    expect(refusal.detail).toContain('claude, codex, opencode, pi, qwen or goose');
    expect(names).toEqual(['commonly-grant-broker']);
  });

  test('names the declaration to change for each reason', () => {
    const details = {};
    for (const [adapter, env] of [
      ['claude', { mcp: [broker()] }],
      ['claude', { sandbox: { mode: 'none' }, mcp: [broker()] }],
      ['claude', { sandbox: { mode: 'firejail', trust: 'public' }, mcp: [broker()] }],
      ['claude', { sandbox: { trust: 'private' }, mcp: [broker()] }],
    ]) {
      const onRefuse = jest.fn();
      withholdGrantBroker(env, adapter, { ...opts, onRefuse });
      const [refusal] = onRefuse.mock.calls[0];
      details[refusal.reason] = refusal.detail;
    }
    expect(Object.keys(details).sort()).toEqual([
      'sandbox_absent', 'sandbox_mode_none', 'sandbox_mode_unenforceable', 'sandbox_trust_not_public',
    ]);
    for (const detail of Object.values(details)) {
      expect(detail).toMatch(/drop the grant broker from this seat/);
    }
  });

  // Identity is the dirty check at every derive site (`isDeepStrictEqual`
  // against the stored record): a fresh object every tick would rewrite the
  // record and restart the seat forever.
  test('returns the SAME reference when nothing is withheld', () => {
    const confined = { sandbox: { trust: 'public' }, mcp: [kernel, broker()] };
    expect(withholdGrantBroker(confined, 'claude', opts)).toBe(confined);
    const noBroker = { model: 'claude-opus-5', mcp: [kernel] };
    expect(withholdGrantBroker(noBroker, 'pi', opts)).toBe(noBroker);
    expect(withholdGrantBroker(undefined, 'pi', opts)).toBeUndefined();
    const onRefuse = jest.fn();
    expect(withholdGrantBroker(confined, 'claude', { ...opts, onRefuse })).toBe(confined);
    expect(onRefuse).not.toHaveBeenCalled();
  });

  test('F175a: a confined OpenCode seat keeps the broker, an unconfined one does not', () => {
    const confined = { sandbox: { trust: 'public' }, mcp: [kernel, broker()] };
    const onRefuse = jest.fn();
    expect(withholdGrantBroker(confined, 'opencode', { ...opts, onRefuse, platform: 'darwin' })).toBe(confined);
    expect(withholdGrantBroker(confined, 'opencode', { ...opts, onRefuse, platform: 'linux' })).toBe(confined);
    expect(onRefuse).not.toHaveBeenCalled();
    for (const [environment, platform, reason] of [
      [{ mcp: [kernel, broker()] }, 'darwin', 'sandbox_absent'],
      [{ sandbox: { mode: 'none', trust: 'public' }, mcp: [kernel, broker()] }, 'darwin', 'sandbox_mode_none'],
      [confined, 'win32', 'sandbox_mode_unenforceable'],
    ]) {
      const refused = jest.fn();
      const out = withholdGrantBroker(environment, 'opencode', { ...opts, onRefuse: refused, platform });
      expect(out.mcp.map((server) => server.name)).toEqual(['commonly']);
      expect(refused.mock.calls[0][0].reason).toBe(reason);
    }
  });
  // F175b wires the broker into codex. The bridge is delivery; this is the
  // gate: a codex seat with no confinement never receives it to wire.
  test('an unconfined codex seat gets no broker', () => {
    const onRefuse = jest.fn();
    const unconfined = { sandbox: { mode: 'workspace', trust: 'private' }, mcp: [kernel, broker()] };
    const out = withholdGrantBroker(unconfined, 'codex', { ...opts, onRefuse, platform: 'darwin' });
    expect(out.mcp.map((server) => server.name)).toEqual(['commonly']);
    expect(onRefuse).toHaveBeenCalledWith(expect.objectContaining({ reason: 'sandbox_trust_not_public' }), ['commonly-grant-broker']);

    const noRecord = { mcp: [kernel, broker()] };
    expect(withholdGrantBroker(noRecord, 'codex', { ...opts, platform: 'darwin' }).mcp.map((s) => s.name)).toEqual(['commonly']);
  });
});

describe('F94: a broker the server says names this seat', () => {
  const unconfined = { sandbox: { mode: 'workspace', trust: 'private' } };
  const named = broker({ name: 'commonly-grant-broker-named', byoNamed: true });

  test('rides a seat this daemon cannot confine; an unnamed broker beside it is still withheld', () => {
    const environment = { ...unconfined, mcp: [kernel, named, broker()] };
    const onRefuse = jest.fn();
    const out = withholdGrantBroker(environment, 'claude', { ...opts, onRefuse, platform: 'darwin' });
    expect(out.mcp.map((server) => server.name)).toEqual(['commonly', 'commonly-grant-broker-named']);
    expect(onRefuse).toHaveBeenCalledWith(expect.objectContaining({ reason: 'sandbox_trust_not_public' }), ['commonly-grant-broker']);
  });

  test('returns the SAME reference when every broker is named', () => {
    const environment = { ...unconfined, mcp: [kernel, named] };
    const onRefuse = jest.fn();
    expect(withholdGrantBroker(environment, 'codex', { ...opts, onRefuse, platform: 'linux' })).toBe(environment);
    expect(onRefuse).not.toHaveBeenCalled();
  });

  test('never rides on native Windows', () => {
    const environment = { ...unconfined, mcp: [kernel, named] };
    const out = withholdGrantBroker(environment, 'claude', { ...opts, platform: 'win32' });
    expect(out.mcp.map((server) => server.name)).toEqual(['commonly']);
  });

  test('never rides an adapter that is not approved for the broker', () => {
    const environment = { sandbox: { trust: 'public' }, mcp: [kernel, named] };
    for (const adapter of ['dsh', 'hermes']) {
      const out = withholdGrantBroker(environment, adapter, { ...opts, platform: 'darwin' });
      expect(out.mcp.map((server) => server.name)).toEqual(['commonly']);
    }
  });

  // F175d: on the broker list, but only confined, so naming lifts nothing here.
  test.each(['qwen', 'goose'])('never rides an unconfined %s seat', (adapter) => {
    const environment = { sandbox: { trust: 'private' }, mcp: [kernel, named] };
    const out = withholdGrantBroker(environment, adapter, { ...opts, platform: 'darwin' });
    expect(out.mcp.map((server) => server.name)).toEqual(['commonly']);
  });

  // F175c: pi carries a grant only confined, so naming lifts nothing for it.
  test('never rides an unconfined pi seat; a public pi seat on macOS keeps it', () => {
    for (const [environment, platform] of [
      [{ ...unconfined, mcp: [kernel, named] }, 'darwin'],
      [{ mcp: [kernel, named] }, 'darwin'],
      [{ sandbox: { trust: 'public' }, mcp: [kernel, named] }, 'linux'],
    ]) {
      const onRefuse = jest.fn();
      const out = withholdGrantBroker(environment, 'pi', { ...opts, onRefuse, platform });
      expect(out.mcp.map((server) => server.name)).toEqual(['commonly']);
      const [refusal] = onRefuse.mock.calls[0];
      expect(refusal.reason).toBe('adapter_confines_public_only');
      expect(refusal.detail).toMatch(/public seat/);
      expect(refusal.detail).toMatch(/macOS/);
      expect(refusal.detail).toMatch(/naming .* does not lift/);
    }
    const confined = { sandbox: { trust: 'public' }, mcp: [kernel, named, broker()] };
    expect(withholdGrantBroker(confined, 'pi', { ...opts, platform: 'darwin' })).toBe(confined);
  });
});
