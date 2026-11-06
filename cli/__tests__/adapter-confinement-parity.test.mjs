/**
 * Local sandbox support and grant-broker admission are separate. An adapter
 * joins the broker set only with its server twin (CONFINING_ADAPTERS in
 * backend/services/grantBrokerConfinement.ts) and a test that its own tools
 * cannot read the per-spawn credential (OpenCode: F175a). Keep this literal pin
 * independent of the sandbox set so adding a sandbox-capable adapter cannot
 * silently grant it room credentials.
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

    expect([...ADAPTERS_WITH_GRANT_BROKER].sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(withheld.sort()).toEqual(['dsh', 'goose', 'hermes', 'pi', 'qwen']);
  });
});
