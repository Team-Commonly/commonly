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

describe('can this daemon confine a seat running this adapter', () => {
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
    ['read-only for codex', 'codex', { sandbox: { mode: 'read-only', trust: 'public' } }, null],
    ['pi, which refuses a declared sandbox and derives none', 'pi', { sandbox: { trust: 'public' } }, 'adapter_cannot_confine'],
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
});

describe('withholding the broker, entry-level', () => {
  const environment = { model: 'claude-opus-5', mcp: [kernel, broker()] };

  test('keeps every other entry and returns a new object', () => {
    const out = withholdGrantBroker(environment, 'pi', opts);
    expect(out.mcp.map((s) => s.name)).toEqual(['commonly']);
    expect(out.model).toBe('claude-opus-5');
    expect(out).not.toBe(environment);
    // The declaration is not edited in place: the caller may still be holding
    // the row it came from.
    expect(environment.mcp).toHaveLength(2);
  });

  test('reports the same typed code the server emits, and which layer decided', () => {
    const onRefuse = jest.fn();
    withholdGrantBroker(environment, 'pi', { ...opts, onRefuse });
    expect(onRefuse).toHaveBeenCalledTimes(1);
    const [refusal, names] = onRefuse.mock.calls[0];
    expect(refusal.code).toBe(GRANT_BROKER_REFUSAL_CODE);
    expect(refusal.code).toBe('grant_broker_unconfined');
    expect(refusal.decidedBy).toBe('daemon');
    expect(refusal.reason).toBe('adapter_cannot_confine');
    expect(refusal.detail).toContain('claude or codex');
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
});
