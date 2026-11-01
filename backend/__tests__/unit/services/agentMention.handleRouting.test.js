/**
 * The intro handle and the context handle are the username mention routing
 * resolves. Fixture: displayName, instanceId and username all differ, so a
 * reader that uses any one of them by mistake fails here.
 */
const AgentIdentityService = require('../../../services/agentIdentityService');
const { buildMentionMap, routedMentionHandle, mentionHandleForUser } = require('../../../services/agentMentionService');

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

// A scoped registry name normalizes to a username no other key produces, so
// only the canonical mapping can route it; and an instance alias is not unique,
// so another install's must never take a canonical username, in either order.
describe('a canonical username names one install, whatever the order', () => {
  const scoped = { agentName: '@acme/foo', instanceId: 'default', displayName: 'Acme Foo' };
  const reviewer = { agentName: 'reviewer', instanceId: 'acmefoo', displayName: 'Reviewer' };
  const scopedTarget = { agentName: '@acme/foo', instanceId: 'default' };

  test('a scoped agent is reached by its canonical username, which no other key provides', () => {
    expect(AgentIdentityService.buildAgentUsername('@acme/foo', 'default')).toBe('acmefoo');
    const { map } = buildMentionMap([scoped], []);
    expect(map.get('acmefoo')).toEqual(scopedTarget);
  });

  test.each([
    ['scoped install first', [scoped, reviewer]],
    ['reviewer install first', [reviewer, scoped]],
  ])("another install's instance alias never takes it (%s)", (_label, installs) => {
    const { map } = buildMentionMap(installs, []);
    expect(map.get('acmefoo')).toEqual(scopedTarget);
    expect(map.get('reviewer-acmefoo')).toEqual({ agentName: 'reviewer', instanceId: 'acmefoo' });
  });
});

describe('routedMentionHandle names a handle that routes to the install in this pod', () => {
  const pair = [
    { agentName: 'codex', instanceId: 'default', displayName: 'Default codex' },
    { agentName: 'codex', instanceId: 'swe-dogfood', displayName: 'Rivet' },
  ];

  test('its canonical username, when that routes', () => {
    const { map } = buildMentionMap(pair, []);
    expect(routedMentionHandle(map, { agentName: 'codex', instanceId: 'swe-dogfood' })).toBe('codex-swe-dogfood');
  });

  test('a default install beside a sibling gets its explicit key, since its bare name routes nowhere', () => {
    const { map } = buildMentionMap(pair, []);
    const handle = routedMentionHandle(map, { agentName: 'codex', instanceId: 'default' });
    expect(handle).toBe('codex-default');
    expect(map.get(handle)).toEqual({ agentName: 'codex', instanceId: 'default' });
  });

  test('a lone default install keeps its bare name', () => {
    const { map } = buildMentionMap([pair[0]], []);
    expect(routedMentionHandle(map, { agentName: 'codex', instanceId: 'default' })).toBe('codex');
  });

  test('an install the pod does not have gets no handle', () => {
    const { map } = buildMentionMap(pair, []);
    expect(routedMentionHandle(map, { agentName: 'codex', instanceId: 'elsewhere' })).toBe('');
  });
});

// An explicit agent-instance key outranks a display slug that spells the same
// thing: the slug is a label anyone can choose, the key is the install.
describe('an explicit agent-instance key beats a display slug equal to it', () => {
  const owner = { agentName: 'codex', instanceId: 'default', displayName: 'Codex' };
  const lookalike = { agentName: 'claude', instanceId: 'desk', displayName: 'Codex Default' };

  test.each([
    ['owner first', [owner, lookalike]],
    ['look-alike first', [lookalike, owner]],
  ])('%s', (_order, installs) => {
    const { map } = buildMentionMap(installs, []);
    expect(map.get('codex-default')).toEqual({ agentName: 'codex', instanceId: 'default' });
  });
});

describe('routedMentionHandle tries a preferred key only while it routes here', () => {
  const helper = { agentName: 'codex', instanceId: 'helper', displayName: 'Assistant' };
  const desk = { agentName: 'claude', instanceId: 'desk', displayName: 'Assistant' };

  test('the preferred slug, when it routes to this install', () => {
    const { map } = buildMentionMap([helper], []);
    expect(routedMentionHandle(map, { agentName: 'codex', instanceId: 'helper' }, { prefer: ['assistant'] }))
      .toBe('assistant');
  });

  test('the routed handle instead, when a later install owns the slug', () => {
    const { map } = buildMentionMap([helper, desk], []);
    expect(map.get('assistant')).toEqual({ agentName: 'claude', instanceId: 'desk' });
    expect(routedMentionHandle(map, { agentName: 'codex', instanceId: 'helper' }, { prefer: ['assistant'] }))
      .toBe('codex-helper');
  });
});

describe('mentionHandleForUser', () => {
  const { map } = buildMentionMap([{ agentName: 'codex', instanceId: 'swe-dogfood', displayName: 'Rivet' }], []);

  test('an agent author gets the handle that routes to its install', () => {
    expect(mentionHandleForUser(map, {
      username: 'codex-swe-dogfood', isBot: true, botMetadata: { agentName: 'codex', instanceId: 'swe-dogfood' },
    })).toBe('codex-swe-dogfood');
  });

  test('a human gets their username, unless an agent in the pod already answers to it', () => {
    expect(mentionHandleForUser(map, { username: 'lily-shen', isBot: false })).toBe('lily-shen');
    expect(mentionHandleForUser(map, { username: 'rivet', isBot: false })).toBe('');
  });

  test('a deleted author, or an agent not installed here, gets no handle', () => {
    expect(mentionHandleForUser(map, null)).toBe('');
    expect(mentionHandleForUser(map, {
      username: 'codex-gone', isBot: true, botMetadata: { agentName: 'codex', instanceId: 'gone' },
    })).toBe('');
  });
});
