/**
 * Self-serve polling seats must be stamped `host: 'byo'` at install.
 *
 * The mislabelling this fixes is a single mismatch: the connect page posts
 * `runtimeType: 'webhook'` (ADR-006's self-serve branch requires that value to
 * synthesize a manifest) while the user never runs a webhook — they run
 * `commonly agent run`, which POLLS. New installs need the explicit BYO host;
 * TASK-222 also makes the read side recognize legacy rows with no stamp.
 *
 * Measured 2026-08-14 (pod-architect): 202 of 314 active installs derive
 * `unknown`, and every real BYO user seat is in that 202, including all four
 * users who mentioned a dead seat and got silence. The honesty surface, the
 * install intro (#943) and W4's stalled-connect trigger all read that
 * derivation — so all three were inert for exactly the population they exist
 * to protect.
 *
 * The rule is tested here as a pure predicate rather than through the install
 * route, which cannot be imported under Node 26 (jsonwebtoken →
 * buffer-equal-constant-time reads the removed SlowBuffer). The predicate is
 * kept identical to install.ts's condition; if that ever drifts, the
 * deriveAgentState assertions below still describe the contract that matters.
 */

const { deriveAgentState } = require('../../../services/agentStateService');

// Mirrors the condition in routes/registry/install.ts.
const shouldStampByo = (runtime) => !runtime.host
  && String(runtime.runtimeType || '').toLowerCase() === 'webhook'
  && !runtime.webhookUrl;

describe('self-serve seats are stamped byo at install', () => {
  test('webhook-typed with no webhookUrl is a polling seat', () => {
    // Exactly what V2AgentBYO.tsx:151 posts.
    expect(shouldStampByo({ runtimeType: 'webhook' })).toBe(true);
  });

  test('a PUSH webhook supplies a URL and must NOT be restamped', () => {
    // The discriminator. No registry route writes webhookUrl — it only ever
    // arrives in caller config — so its presence means a real push webhook,
    // which deriveAgentState already calls reachable by construction.
    expect(shouldStampByo({ runtimeType: 'webhook', webhookUrl: 'https://example.com/hook' })).toBe(false);
  });

  test('an explicit host is never overwritten', () => {
    // The CLI attach path already sets this correctly.
    expect(shouldStampByo({ runtimeType: 'webhook', host: 'cloud' })).toBe(false);
    expect(shouldStampByo({ runtimeType: 'claude-code', host: 'byo' })).toBe(false);
  });

  test('native and other runtimes are untouched', () => {
    expect(shouldStampByo({ runtimeType: 'native' })).toBe(false);
    expect(shouldStampByo({})).toBe(false);
  });
});

describe('stamped and legacy polling seats both reach the honesty surface', () => {
  const install = (runtime) => ({
    agentName: 'kaka-agent', instanceId: 'default', installedBy: 'u1', config: { runtime }, runtimeTokens: [],
  });

  test('a legacy never-run seat without the stamp still reads `never-connected`', () => {
    // TASK-222 repairs existing polling seats as well as stamping new ones.
    const state = deriveAgentState(install({ runtimeType: 'webhook' }), [], 'u1');

    expect(state.state).toBe('never-connected');
    expect(state.fixCommand).toBe('commonly agent run kaka-agent');
  });

  test('WITH the stamp the same seat reads `never-connected` and offers the fix', () => {
    const state = deriveAgentState(install({ runtimeType: 'webhook', host: 'byo' }), [], 'u1');

    expect(state.state).toBe('never-connected');
    expect(state.fixCommand).toBe('commonly agent run kaka-agent');
  });

  test('a stamped seat that HAS been polled recently reads listening', () => {
    // The stamp must not make everything look broken — it makes the answer
    // knowable in both directions.
    const state = deriveAgentState(
      install({ runtimeType: 'webhook', host: 'byo' }),
      [{ lastListenedAt: new Date() }],
      'u1',
    );

    expect(state.state).toBe('listening');
  });
});
