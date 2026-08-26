jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));

const { shouldEscalate, routeReplyContent } = require('../../../services/telegramBridgeService');

describe('telegramBridgeService — escalation gate', () => {
  const integration = (config = {}) => ({ _id: 'i1', podId: 'p1', config });

  it('relays nothing by default (the channel stays quiet)', () => {
    expect(shouldEscalate({
      content: 'refactored the parser, tests green',
      agentUsername: 'worker-a',
      integration: integration({}),
    })).toBe(false);
  });

  it('escalates [BLOCKED] and [DECISION] markers', () => {
    for (const marker of ['[BLOCKED]', '[ESCALATE]', '[DECISION]', '[NEEDS-HUMAN]', '[blocked]']) {
      expect(shouldEscalate({
        content: `${marker} waiting on scope confirmation`,
        agentUsername: 'worker-a',
        integration: integration({}),
      })).toBe(true);
    }
  });

  it('escalates a question addressed at someone', () => {
    expect(shouldEscalate({
      content: '@sam should the retention window stay at 30 days?',
      agentUsername: 'worker-a',
      integration: integration({}),
    })).toBe(true);
  });

  it('always relays the designated lead agent, case-insensitively', () => {
    expect(shouldEscalate({
      content: 'daily digest: 3 tasks done, 1 in review',
      agentUsername: 'Lead-Agent',
      integration: integration({ leadAgentUsername: 'lead-agent' }),
    })).toBe(true);
  });

  it('relayAllAgentMessages opts into verbose mode', () => {
    expect(shouldEscalate({
      content: 'minor progress note',
      agentUsername: 'worker-a',
      integration: integration({ relayAllAgentMessages: true }),
    })).toBe(true);
  });
});

describe('telegramBridgeService — quote-reply routing', () => {
  const relayMap = [
    { tgMessageId: '101', agentUsername: 'gene-fix-agent' },
    { tgMessageId: '102', agentUsername: 'lead-agent' },
  ];

  it('prefixes the quoted agent as an @mention', () => {
    const out = routeReplyContent({
      content: 'looks wrong, use the v2 schema',
      replyToTgMessageId: '101',
      relayMap,
    });
    expect(out.routedAgent).toBe('gene-fix-agent');
    expect(out.content).toBe('@gene-fix-agent looks wrong, use the v2 schema');
  });

  it('does not double-prefix when the mention is already present', () => {
    const out = routeReplyContent({
      content: '@gene-fix-agent try again with the v2 schema',
      replyToTgMessageId: '101',
      relayMap,
    });
    expect(out.routedAgent).toBe('gene-fix-agent');
    expect(out.content).toBe('@gene-fix-agent try again with the v2 schema');
  });

  it('passes through untouched when the quote is not a relayed line', () => {
    const out = routeReplyContent({
      content: 'unrelated reply',
      replyToTgMessageId: '999',
      relayMap,
    });
    expect(out.routedAgent).toBeNull();
    expect(out.content).toBe('unrelated reply');
  });

  it('passes through when there is no quote at all', () => {
    const out = routeReplyContent({ content: 'plain message', replyToTgMessageId: null, relayMap });
    expect(out.routedAgent).toBeNull();
    expect(out.content).toBe('plain message');
  });
});
