/**
 * Local sandbox support and grant-broker admission are separate. An adapter
 * joins the broker set only with its server twin (CONFINING_ADAPTERS in
 * backend/services/grantBrokerConfinement.ts) and a test that its own tools
 * cannot read the per-spawn credential (OpenCode: F175a). Keep this literal pin
 * independent of the sandbox set so adding a sandbox-capable adapter cannot
 * silently grant it room credentials.
 */
import { listAdapterNames } from '../src/lib/adapters/index.js';
import { ADAPTERS_WITH_GRANT_BROKER, ADAPTERS_WITH_PUBLIC_ONLY_GRANT } from '../src/lib/default-environment.js';

describe('adapter registry and grant-broker admission stay explicit', () => {
  test('only the approved adapters receive the broker', () => {
    const names = listAdapterNames();
    // Positive control: the registry is really being read, so the subtraction
    // below cannot be empty for the trivial reason.
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    expect(names).toContain('pi');

    const eligible = new Set([...ADAPTERS_WITH_GRANT_BROKER, 'stub']);
    const withheld = names.filter((name) => !eligible.has(name));

    expect([...ADAPTERS_WITH_GRANT_BROKER].sort()).toEqual(['claude', 'codex', 'goose', 'opencode', 'pi', 'qwen']);
    expect(withheld.sort()).toEqual(['dsh', 'hermes']);
  });

  // F175c, F175d: these hold a grant only on a public seat; naming never lifts
  // that. Pinned so another adapter cannot slip onto the narrower rule, or off
  // it, without a test saying so.
  test('pi, Qwen and Goose are the adapters that carry a grant only when public', () => {
    expect([...ADAPTERS_WITH_PUBLIC_ONLY_GRANT.keys()].sort()).toEqual(['goose', 'pi', 'qwen']);
    for (const name of ADAPTERS_WITH_PUBLIC_ONLY_GRANT.keys()) expect(ADAPTERS_WITH_GRANT_BROKER.has(name)).toBe(true);
  });
});
