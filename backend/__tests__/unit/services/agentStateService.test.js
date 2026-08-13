/**
 * agentStateService.deriveAgentState — #891 surface 1's honesty rules, pure.
 *
 * Contract under test (each rule earned by a measured review finding):
 *  - BYO installs derive from lastUsedAt: null → never-connected,
 *    fresh → listening, stale → gone-dark
 *  - the union of BOTH token stores decides (finding D: legacy/new split
 *    made live agents read null)
 *  - native and push-webhook installs are 'reachable' by construction
 *  - gateway/cloud classes are 'unknown' — never guessed (finding A)
 *  - fixCommand attaches ONLY for the owner, only in fixable states
 *    (split key: instructions to someone who can't perform them are the
 *    P1/P2 contradiction)
 */

const { deriveAgentState, AGENT_LISTENING_STALE_MS } = require('../../../services/agentStateService');

const NOW = 1_700_000_000_000;

const byoInstall = (overrides = {}) => ({
  agentName: 'sam-agent',
  instanceId: 'default',
  displayName: 'Sam Agent',
  installedBy: 'owner-1',
  config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
  runtimeTokens: [],
  ...overrides,
});

describe('deriveAgentState', () => {
  test('BYO with no token use anywhere → never-connected, owner gets the fix command', () => {
    const row = deriveAgentState(byoInstall(), [], 'owner-1', NOW);
    expect(row.state).toBe('never-connected');
    expect(row.fixCommand).toBe('commonly agent run sam-agent');
  });

  test('the same state seen by a NON-owner carries the explanation but no instruction', () => {
    const row = deriveAgentState(byoInstall(), [], 'someone-else', NOW);
    expect(row.state).toBe('never-connected');
    expect(row.isOwner).toBe(false);
    expect(row.fixCommand).toBeUndefined();
  });

  test('fresh use on the INSTALLATION token store → listening', () => {
    const row = deriveAgentState(
      byoInstall({ runtimeTokens: [{ lastUsedAt: new Date(NOW - 10_000) }] }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('listening');
    expect(row.fixCommand).toBeUndefined(); // nothing to fix
  });

  test('fresh use on the USER token store alone also counts — the union decides (finding D)', () => {
    const row = deriveAgentState(
      byoInstall(),
      [{ lastUsedAt: new Date(NOW - 10_000) }],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('listening');
  });

  test('stale use → gone-dark, and the owner gets the wake command', () => {
    const row = deriveAgentState(
      byoInstall({ runtimeTokens: [{ lastUsedAt: new Date(NOW - AGENT_LISTENING_STALE_MS - 1000) }] }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('gone-dark');
    expect(row.fixCommand).toBe('commonly agent run sam-agent');
  });

  test('native runtime is reachable by construction — no dot, no lastUsedAt reading', () => {
    const row = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'native' } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('reachable');
    expect(row.lastUsedAt).toBeNull();
  });

  test('a push webhook (webhookUrl set) is reachable regardless of token use', () => {
    const row = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'webhook', host: 'byo', webhookUrl: 'https://x.example/cap' } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('reachable');
  });

  test('gateway/cloud classes are unknown — never guessed from a shared boot timestamp (finding A)', () => {
    const row = deriveAgentState(
      byoInstall({
        config: { runtime: { runtimeType: 'moltbot', host: 'cloud' } },
        runtimeTokens: [{ lastUsedAt: new Date(NOW - 5_000) }], // fresh, and still not trusted
      }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('unknown');
    expect(row.fixCommand).toBeUndefined();
  });

  test('legacy local-cli installs count as BYO', () => {
    const row = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'local-cli' } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('never-connected');
  });
});
