/**
 * The intro handle and the context handle are the username mention routing
 * resolves. Fixture: displayName, instanceId and username all differ, so a
 * reader that uses any one of them by mistake fails here.
 */
const AgentIdentityService = require('../../../services/agentIdentityService');
const { buildMentionMap } = require('../../../services/agentMentionService');

const installation = {
  agentName: 'codex',
  instanceId: 'swe-dogfood',
  displayName: 'Rivet',
};

describe('mention handle routes', () => {
  test('the canonical username is a key buildMentionMap routes to the install', () => {
    const handle = AgentIdentityService.buildAgentUsername('codex', 'swe-dogfood');
    const { map } = buildMentionMap([installation], []);

    expect(handle).toBe('codex-swe-dogfood');
    expect(map.get(handle)).toEqual({ agentName: 'codex', instanceId: 'swe-dogfood' });
  });

  test('the display name is not the handle, and is not what routes', () => {
    const { map } = buildMentionMap([installation], []);

    expect(map.get('rivet')).toEqual({ agentName: 'codex', instanceId: 'swe-dogfood' });
    expect(AgentIdentityService.buildAgentUsername('codex', 'swe-dogfood')).not.toBe('rivet');
  });
});

describe('bare agentName stays governed by the single-install rule', () => {
  test('a default-instance install routes its bare name only when it is the only install', () => {
    const solo = buildMentionMap([{ agentName: 'codex', instanceId: 'default' }], []);
    expect(AgentIdentityService.buildAgentUsername('codex', 'default')).toBe('codex');
    expect(solo.map.get('codex')).toEqual({ agentName: 'codex', instanceId: 'default' });

    const pair = buildMentionMap([
      { agentName: 'codex', instanceId: 'default', displayName: 'Default codex' },
      { agentName: 'codex', instanceId: 'swe-dogfood', displayName: 'Rivet' },
    ], []);
    expect(pair.map.has('codex')).toBe(false);
    expect(pair.map.get('codex-swe-dogfood')).toEqual({ agentName: 'codex', instanceId: 'swe-dogfood' });
  });
});
