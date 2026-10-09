/**
 * Local sandbox support and server grant-broker admission are separate.
 * OpenCode enforces a public sandbox locally, but it remains ineligible for the
 * broker until the server's per-adapter confinement proof includes it. Keep
 * this literal pin independent of the sandbox set so adding a sandbox-capable
 * adapter cannot silently grant it room credentials.
 */
import { listAdapterNames } from '../src/lib/adapters/index.js';
import { ADAPTERS_WITH_GRANT_BROKER } from '../src/lib/default-environment.js';

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

    expect([...ADAPTERS_WITH_GRANT_BROKER].sort()).toEqual(['claude', 'codex']);
    expect(withheld.sort()).toEqual(['opencode', 'pi']);
  });
});
