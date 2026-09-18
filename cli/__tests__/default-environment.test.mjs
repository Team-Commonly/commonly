// The baseline an mcp-consuming wrapper seat gets when its environment
// declares no commonly server (TASK-048).
import {
  ADAPTERS_WITH_DEFAULT_MCP,
  ADAPTERS_WITH_DEFAULT_SANDBOX,
  COMMONLY_DEFAULT_SANDBOX,
  COMMONLY_MCP_SERVER_NAME,
  commonlyMcpServer,
  defaultMcpServers,
  defaultSeatSandbox,
  seatBaseline,
  withDefaultMcpServer,
  withDefaultSandbox,
} from '../src/lib/default-environment.js';
import { assertNoSandboxDeclared } from '../src/lib/adapters/pi.js';

describe('defaultMcpServers', () => {
  test.each(['claude', 'codex', 'pi'])('hands %s the commonly server', (adapterName) => {
    expect(defaultMcpServers(adapterName)).toEqual([commonlyMcpServer()]);
  });

  test('hands an adapter with no consumption path nothing', () => {
    expect(defaultMcpServers('stub')).toEqual([]);
    expect(defaultMcpServers(undefined)).toEqual([]);
  });

  test('the declaration carries placeholders, never a secret', () => {
    const [server] = defaultMcpServers('claude');
    expect(server.env).toEqual({
      COMMONLY_API_URL: '${COMMONLY_API_URL}',
      COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
    });
  });

  test('ADAPTERS_WITH_DEFAULT_MCP matches the adapters this test names', () => {
    expect([...ADAPTERS_WITH_DEFAULT_MCP].sort()).toEqual(['claude', 'codex', 'pi']);
  });

  test('ADAPTERS_WITH_DEFAULT_SANDBOX is the enforcing subset, pi excluded', () => {
    expect([...ADAPTERS_WITH_DEFAULT_SANDBOX].sort()).toEqual(['claude', 'codex']);
    expect(ADAPTERS_WITH_DEFAULT_SANDBOX.has('pi')).toBe(false);
  });
});

describe('withDefaultMcpServer', () => {
  test('creates the declaration when the environment is absent', () => {
    expect(withDefaultMcpServer(null, 'pi')).toEqual({ mcp: [commonlyMcpServer()] });
    expect(withDefaultMcpServer(undefined, 'claude')).toEqual({ mcp: [commonlyMcpServer()] });
  });

  test('adds the declaration to an environment that has none, keeping its other facets', () => {
    const environment = { model: 'deepseek-v4-flash', effort: 'high' };
    expect(withDefaultMcpServer(environment, 'pi')).toEqual({
      ...environment,
      mcp: [commonlyMcpServer()],
    });
  });

  test('appends after declared servers — a url-only grant broker is not the kernel server', () => {
    const environment = { mcp: [{ name: 'room-grants', transport: 'http' }] };
    const next = withDefaultMcpServer(environment, 'claude');
    expect(next.mcp.map((server) => server.name)).toEqual(['room-grants', COMMONLY_MCP_SERVER_NAME]);
  });

  test('never duplicates or replaces a declared commonly entry', () => {
    const handSet = { name: 'commonly', command: ['node', '/opt/commonly/mcp-staging/src/index.js'] };
    const environment = { mcp: [handSet] };
    const next = withDefaultMcpServer(environment, 'claude');
    expect(next).toBe(environment);
    expect(next.mcp).toEqual([handSet]);
  });

  test('returns the same reference when nothing changes, so callers can dirty-check', () => {
    const declared = { mcp: [commonlyMcpServer()] };
    expect(withDefaultMcpServer(declared, 'pi')).toBe(declared);
    const stub = { model: 'x' };
    expect(withDefaultMcpServer(stub, 'stub')).toBe(stub);
    expect(withDefaultMcpServer(stub, undefined)).toBe(stub);
  });

  test('does not invent a declaration for an adapter that cannot consume one', () => {
    expect(withDefaultMcpServer(null, 'stub')).toBeNull();
    expect(withDefaultMcpServer({ model: 'x' }, 'stub')).toEqual({ model: 'x' });
  });

  test('leaves a malformed environment alone rather than repairing it', () => {
    expect(withDefaultMcpServer('nonsense', 'claude')).toBe('nonsense');
    expect(withDefaultMcpServer([1, 2], 'claude')).toEqual([1, 2]);
  });

  test('is idempotent', () => {
    const once = withDefaultMcpServer({ model: 'x' }, 'codex');
    expect(withDefaultMcpServer(once, 'codex')).toBe(once);
  });
});

// TASK-052 / C4-6: an undeclared sandbox is an unconfined seat. `sandbox.mode`
// defaults to 'none' in the adapters, so "no sandbox block" and "mode: none"
// are the same thing to the spawn.
describe('withDefaultSandbox', () => {
  test('declares the default sandbox when there is none', () => {
    expect(withDefaultSandbox(null)).toEqual({ sandbox: defaultSeatSandbox() });
    expect(withDefaultSandbox({ model: 'opus' })).toEqual({
      model: 'opus',
      sandbox: { trust: 'public' },
    });
  });

  test('stores NO mode: the record is portable, the host is not', () => {
    // `mode: 'workspace'` in a row breaks every Linux daemon host (it maps to
    // Seatbelt on macOS and is refused elsewhere) and `mode: 'bwrap'` is
    // meaningless on macOS. The adapters resolve the mode at spawn instead, so
    // re-homing a seat to the other platform cannot make it unspawnable.
    expect(COMMONLY_DEFAULT_SANDBOX).toEqual({ trust: 'public' });
    expect(Object.prototype.hasOwnProperty.call(COMMONLY_DEFAULT_SANDBOX, 'mode')).toBe(false);
    expect(withDefaultSandbox(null).sandbox.mode).toBeUndefined();
  });

  test('replaces an explicitly disengaged sandbox on this path', () => {
    // Only ever called for daemon-derived environments; a server that says
    // `mode: 'none'` is saying "unconfined", which is what the default is for.
    expect(withDefaultSandbox({ sandbox: { mode: 'none' } }).sandbox)
      .toEqual({ trust: 'public' });
    expect(withDefaultSandbox({ sandbox: { mode: 'none', trust: 'public' } }).sandbox)
      .toEqual({ trust: 'public' });
    expect(withDefaultSandbox({ sandbox: {} }).sandbox)
      .toEqual({ trust: 'public' });
    expect(withDefaultSandbox({ sandbox: 'none' }).sandbox)
      .toEqual({ trust: 'public' });
  });

  test('never overrides an enforced sandbox, including read-only', () => {
    const declared = { sandbox: { mode: 'read-only', trust: 'public' } };
    expect(withDefaultSandbox(declared)).toBe(declared);
    const workspace = { sandbox: { mode: 'workspace', trust: 'internal' } };
    expect(withDefaultSandbox(workspace)).toBe(workspace);
    const bwrap = { sandbox: { mode: 'bwrap' } };
    expect(withDefaultSandbox(bwrap)).toBe(bwrap);
    // The derived shape itself is enforced — without this, every tick would
    // rewrite the record and restart the seat forever.
    const derived = { sandbox: { trust: 'public' } };
    expect(withDefaultSandbox(derived)).toBe(derived);
  });

  test('leaves a malformed environment alone, and is idempotent', () => {
    expect(withDefaultSandbox('nonsense')).toBe('nonsense');
    expect(withDefaultSandbox([1])).toEqual([1]);
    const once = withDefaultSandbox({ model: 'x' });
    expect(withDefaultSandbox(once)).toBe(once);
  });

  test('the constant is frozen: the default cannot be edited in place', () => {
    expect(Object.isFrozen(COMMONLY_DEFAULT_SANDBOX)).toBe(true);
  });
});

describe('seatBaseline', () => {
  test('adds the sandbox only when asked, and only for a consuming adapter', () => {
    const bare = seatBaseline(null, 'claude');
    expect(bare.sandbox).toBeUndefined();
    expect(bare.mcp).toEqual([commonlyMcpServer()]);

    const confined = seatBaseline(null, 'claude', { sandbox: true });
    expect(confined).toEqual({
      sandbox: { trust: 'public' },
      mcp: [commonlyMcpServer()],
    });

    // No consumption path: nothing is invented, sandbox included.
    expect(seatBaseline(null, 'stub', { sandbox: true })).toBeNull();
  });

  test('keeps an enforced sandbox while adding the mcp default', () => {
    const declared = { sandbox: { mode: 'read-only', trust: 'public' } };
    expect(seatBaseline(declared, 'codex', { sandbox: true })).toEqual({
      sandbox: { mode: 'read-only', trust: 'public' },
      mcp: [commonlyMcpServer()],
    });
  });

  test('is idempotent on both halves', () => {
    const once = seatBaseline(null, 'codex', { sandbox: true });
    expect(seatBaseline(once, 'codex', { sandbox: true })).toBe(once);
  });

  // The sandbox half is written for the adapters that can enforce it, and NOT
  // for every adapter that consumes mcp[]. pi fails closed on a declared
  // sandbox (#1727), so a baseline carrying one is a seat that cannot start —
  // the invariant is not "no sandbox key" but "the spec this adapter receives
  // is one this adapter accepts", which is what is asserted here by running the
  // derived value through pi's own guard rather than by inspecting a key.
  test('gives pi the mcp half only, and a spec its own guard accepts', () => {
    const derived = seatBaseline(null, 'pi', { sandbox: true });
    expect(derived.sandbox).toBeUndefined();
    expect(derived).toEqual({ mcp: [commonlyMcpServer()] });
    expect(() => assertNoSandboxDeclared(derived)).not.toThrow();
    // The control: the same baseline handed to an enforcing adapter does carry
    // it, so the absence above is the adapter set and not a missing default.
    expect(seatBaseline(null, 'claude', { sandbox: true }).sandbox)
      .toEqual(defaultSeatSandbox());
  });
});
