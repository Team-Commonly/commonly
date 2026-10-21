/**
 * ADR-018 D8.1: an agent a person brings into a pod wakes on every human
 * message by default. Several listening agents are made safe by the claim
 * inbox (D8, D6.1, D7), so every such agent gets the default, not only the
 * first.
 */
const { personAgentWakeDefault, isPersonBroughtAgent } = require('../../../services/wakeDefaultService');

const NOW = new Date('2026-10-21T09:00:00Z');
const OWN_AGENT = { runtime: { runtimeType: 'webhook', host: 'byo' } };
const ON_COMPUTER = { runtime: { runtimeType: 'wrapper' } };

describe('an agent a person brings into a pod wakes on every human message', () => {
  test('an own agent defaults on: human-only, no board wakes', () => {
    expect(personAgentWakeDefault(OWN_AGENT, NOW)).toEqual({
      wakeOnMessage: {
        enabled: true, humanOnly: true, reason: 'person-agent-default', defaultedAt: NOW.toISOString(),
      },
      boardWake: { enabled: false },
    });
  });

  test('an agent placed on the person\'s computer defaults on too', () => {
    expect(personAgentWakeDefault(ON_COMPUTER, NOW).wakeOnMessage.enabled).toBe(true);
  });

  test('an explicit wakeOnMessage in the request wins, either way', () => {
    expect(personAgentWakeDefault({ ...OWN_AGENT, wakeOnMessage: { enabled: false } }, NOW)).toBeNull();
    expect(personAgentWakeDefault({ ...OWN_AGENT, wakeOnMessage: { enabled: true } }, NOW)).toBeNull();
  });

  test('an explicit boardWake in the request is left alone', () => {
    const patch = personAgentWakeDefault({ ...OWN_AGENT, boardWake: { enabled: true } }, NOW);
    expect(patch.wakeOnMessage.enabled).toBe(true);
    expect(patch).not.toHaveProperty('boardWake');
  });

  test('hosted agents, first-party apps, CLI attaches and push webhooks are untouched', () => {
    for (const runtime of [
      { runtimeType: 'hosted' },
      { runtimeType: 'native' },
      { runtimeType: 'claude-code', host: 'byo' },
      { runtimeType: 'codex', host: 'byo' },
      { runtimeType: 'webhook', host: 'byo', webhookUrl: 'https://example.test/hook' },
      { runtimeType: 'webhook' },
    ]) {
      expect(personAgentWakeDefault({ runtime }, NOW)).toBeNull();
    }
  });

  test('isPersonBroughtAgent reads the normalized runtime block', () => {
    expect(isPersonBroughtAgent({ runtime: { runtimeType: ' Wrapper ' } })).toBe(true);
    expect(isPersonBroughtAgent({})).toBe(false);
  });
});
