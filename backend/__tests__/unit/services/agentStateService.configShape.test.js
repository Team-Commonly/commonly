/**
 * `deriveAgentState` reads `config.runtime` directly, and `AgentInstallation`
 * declares `config: { type: Map, of: Mixed }` (AgentRegistry.ts:235). So the
 * SHAPE of what you hand it decides the answer:
 *
 *   - `.lean()` / `.toObject()` → plain object → `config.runtime` works
 *   - a live Mongoose document   → Map        → `config.runtime` is undefined
 *
 * Caught live 2026-08-14, not in CI. After the host:'byo' stamp shipped, a seat
 * minted by the real connect flow derived `never-connected` through
 * /agent-states (which uses `.lean()`) while the install route — holding the
 * live document — derived `unknown` and posted "Mention me with @handle when
 * you need me" to a seat with nobody home. Two readers of one field
 * disagreeing purely because one held a document.
 *
 * Every existing unit test passed throughout, because they all pass plain
 * objects. These pin the failure mode itself so a future caller that forgets
 * `.lean()` fails here instead of in production copy.
 */

const { deriveAgentState } = require('../../../services/agentStateService');

const base = { agentName: 'stamp-verify-agent', instanceId: 'default', installedBy: 'u1' };

describe('deriveAgentState is shape-sensitive on config', () => {
  test('a plain object (what .lean() gives) reads the stamp', () => {
    const state = deriveAgentState(
      { ...base, config: { runtime: { runtimeType: 'webhook', host: 'byo' } }, runtimeTokens: [] },
      [],
      'u1',
    );

    expect(state.state).toBe('never-connected');
  });

  test('a Mongoose Map silently reads as NO runtime — the live bug', () => {
    // Not a recommendation, a warning: this is what the install route passed.
    // A Map has no `.runtime` property, so the honesty layer goes blind and
    // answers `unknown` — which renders as the cheerful invitation.
    const state = deriveAgentState(
      { ...base, config: new Map([['runtime', { runtimeType: 'webhook', host: 'byo' }]]), runtimeTokens: [] },
      [],
      'u1',
    );

    expect(state.state).toBe('unknown');
    expect(state.fixCommand).toBeUndefined();
  });

  test('normalizing the Map first restores the correct answer', () => {
    // The fix applied at the install call site.
    const { normalizeConfigMap } = require('../../../routes/registry/helpers');
    const map = new Map([['runtime', { runtimeType: 'webhook', host: 'byo' }]]);

    const state = deriveAgentState(
      { ...base, config: normalizeConfigMap(map) || {}, runtimeTokens: [] },
      [],
      'u1',
    );

    expect(state.state).toBe('never-connected');
    expect(state.fixCommand).toBe('commonly agent run stamp-verify-agent');
  });
});
