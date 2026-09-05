jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));

const telegramSend = require('../../../services/telegramService');
const {
  shouldEscalate,
  routeReplyContent,
  isRelayableIntegration,
  isInboundRelayableIntegration,
  relayTelegramMessageToPod,
} = require('../../../services/telegramBridgeService');

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

  it('overlays a gate mode and lead on the connector defaults for that pod', () => {
    const gated = integration({
      relayAllAgentMessages: true,
      leadAgentUsername: 'default-lead',
      gates: {
        'pod-a': { enabled: true, mode: 'attention', lead: 'pod-lead' },
        'pod-b': { enabled: true, mode: 'mirror' },
      },
    });
    expect(shouldEscalate({
      content: 'ordinary progress', agentUsername: 'worker', integration: gated, podId: 'pod-a',
    })).toBe(false);
    expect(shouldEscalate({
      content: 'ordinary progress', agentUsername: 'pod-lead', integration: gated, podId: 'pod-a',
    })).toBe(true);
    expect(shouldEscalate({
      content: 'ordinary progress', agentUsername: 'worker', integration: gated, podId: 'pod-b',
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

  // TASK-099 site 7. The two cases below returned an identical value, so a
  // caller could not tell "nobody quoted anything" from "someone quoted a
  // relayed line and we failed to route it". Both still relay; only the
  // second is a failure, and `replyStatus` is the only thing that says so.
  describe('a quote-reply that does not route is distinguishable from no quote', () => {
    it('reports not-a-reply when there was no quote', () => {
      const out = routeReplyContent({ content: 'plain message', replyToTgMessageId: null, relayMap });
      expect(out.replyStatus).toBe('not-a-reply');
      expect(out.routedAgent).toBeNull();
    });

    it('reports unmatched when the quoted message is absent from the relayMap', () => {
      const out = routeReplyContent({
        content: 'unrelated reply',
        replyToTgMessageId: '999',
        relayMap,
      });
      expect(out.replyStatus).toBe('unmatched');
      expect(out.routedAgent).toBeNull();
      // The routing behaviour is deliberately unchanged: still relayed, still
      // unaddressed. Only the reporting is new.
      expect(out.content).toBe('unrelated reply');
    });

    it('reports unmatched when the entry aged out past RELAY_MAP_CAP', () => {
      // The eviction case, which is why this is not a corner: the writer
      // $slices the map to the newest 100 entries while Telegram scrollback
      // keeps every relayed message long-pressable.
      const evicted = Array.from({ length: 100 }, (_, i) => ({
        tgMessageId: String(1000 + i),
        agentUsername: 'gene-fix-agent',
      }));
      const out = routeReplyContent({
        content: 'reply to something old',
        replyToTgMessageId: '101',
        relayMap: evicted,
      });
      expect(out.replyStatus).toBe('unmatched');
      expect(out.routedAgent).toBeNull();
    });

    it('reports unmatched when the integration has no relayMap at all', () => {
      const out = routeReplyContent({ content: 'reply', replyToTgMessageId: '101', relayMap: undefined });
      expect(out.replyStatus).toBe('unmatched');
    });

    it('reports unmatched when the matched entry carries no agentUsername', () => {
      const out = routeReplyContent({
        content: 'reply',
        replyToTgMessageId: '101',
        relayMap: [{ tgMessageId: '101', agentUsername: null }],
      });
      expect(out.replyStatus).toBe('unmatched');
      expect(out.routedAgent).toBeNull();
    });

    it('reports routed on a hit', () => {
      const out = routeReplyContent({
        content: 'looks wrong',
        replyToTgMessageId: '101',
        relayMap,
      });
      expect(out.replyStatus).toBe('routed');
      expect(out.routedAgent).toBe('gene-fix-agent');
    });
  });
});

describe('telegramBridgeService — user-scope outbound gate', () => {
  const userScoped = {
    _id: 'i1',
    scope: 'user',
    podId: 'active-pod',
    type: 'telegram',
    isActive: true,
    config: {
      liveRelay: true,
      chatType: 'private',
      chatId: 'chat-1',
      gates: { 'other-pod': { enabled: true } },
    },
  };

  it('allows an enabled gate rather than only the selected pod', () => {
    expect(isRelayableIntegration(userScoped, 'other-pod')).toBe(true);
  });

  it('refuses a disabled or absent gate', () => {
    expect(isRelayableIntegration({
      ...userScoped,
      config: { ...userScoped.config, gates: { 'other-pod': { enabled: false } } },
    }, 'other-pod')).toBe(false);
    expect(isRelayableIntegration(userScoped, 'missing-pod')).toBe(false);
  });

  it('keeps inbound on the active pod when its outbound gate is disabled', () => {
    expect(isInboundRelayableIntegration({
      ...userScoped,
      config: { ...userScoped.config, gates: { 'active-pod': { enabled: false } } },
    }, 'active-pod')).toBe(true);
  });

  it('answers once in the linked chat when a user connector has no active pod', async () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    try {
      const result = await relayTelegramMessageToPod({
        integration: { ...userScoped, podId: undefined },
        telegramMessage: { text: 'hello from the phone' },
      });

      expect(result).toEqual({ relayed: false });
      expect(telegramSend.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegramSend.sendMessage).toHaveBeenCalledWith(
        'bot-token', 'chat-1', 'This connector has no active pod. Choose one in Commonly first.',
      );
    } finally {
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });
});
