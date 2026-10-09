/**
 * The server's confinementless-adapter list and the cli's adapter registry must
 * name the same set (TASK-175, Wren 12:10Z).
 *
 * The two halves use OPPOSITE polarities, and neither can import the other: the
 * backend refuses only the adapters it lists
 * (`backend/services/grantBrokerConfinement.ts` `CONFINEMENTLESS_ADAPTERS`,
 * asserted as `['pi']` in its own suite), while the daemon admits only claude
 * and codex (`src/lib/grant-broker-guard.js`). They agree today on every adapter
 * that can call a tool — the registry is stub, claude, codex and pi, and stub
 * makes no calls — so a NEW adapter added here would pass the endpoint while the
 * daemon refused it, or the reverse, and nothing would fail.
 *
 * The two literal pins are the guard: adding an adapter reddens this test until
 * both lists are updated deliberately.
 */
import { listAdapterNames } from '../src/lib/adapters/index.js';

describe('the adapter registry and the server refusal list agree', () => {
  test('every adapter except the confining ones and the stub is the server list', () => {
    const names = listAdapterNames();
    // Positive control: the registry is really being read, so the subtraction
    // below cannot be empty for the trivial reason.
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    expect(names).toContain('pi');

    const confinementless = names.filter((name) => !['claude', 'codex', 'stub'].includes(name));

    // Keep this literal identical to CONFINEMENTLESS_ADAPTERS
    // (backend/services/grantBrokerConfinement.ts). A new adapter lands here
    // first, and then has to be classified on the server side too.
    expect(confinementless.sort()).toEqual(['pi']);
  });
});
