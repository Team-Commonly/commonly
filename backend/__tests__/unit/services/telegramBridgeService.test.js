jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn() }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
// Stub the network, keep the behaviour: the bridge escapes through this module's
// escapeHtml, so a bare stub leaves it undefined and the send is swallowed.
jest.mock('../../../services/telegramService', () => ({
  ...jest.requireActual('../../../services/telegramService'),
  sendMessage: jest.fn(),
}));

const telegramSend = require('../../../services/telegramService');
const IntegrationModel = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const PGMessage = require('../../../models/pg/Message');
const { deliverMessageToAgents } = require('../../../services/messageAgentDeliveryService');
const {
  shouldEscalate,
  routeReplyContent,
  isRelayableIntegration,
  isInboundRelayableIntegration,
  relayAgentMessageToTelegram,
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

// ADR-025 D10/D11. A user-scoped connector has ONE active inbound destination
// (`podId`) and N gated pods. Before this, a quote-reply landed in the active pod
// whichever pod the quoted line came from, so the user's answer to B was authored
// into A and the agent it named woke there without B's thread; and Telegram's
// outbound line carried no pod tag, so a reader could not tell the two apart.
describe('telegramBridgeService — multi-pod routing', () => {
  const ORIGINAL_POD = 'pod-a';
  const GATED_POD = 'pod-b';
  const userScoped = (overrides = {}) => ({
    _id: 'i1',
    scope: 'user',
    podId: ORIGINAL_POD,
    type: 'telegram',
    isActive: true,
    config: {
      liveRelay: true,
      chatType: 'private',
      chatId: 'chat-1',
      linkedUserId: 'user-1',
      // pod-a is the active inbound destination and its gate is OFF, which is
      // legal: inbound does not consult gates (isInboundRelayableIntegration).
      gates: { [GATED_POD]: { enabled: true } },
      relayMap: [
        { tgMessageId: '101', agentUsername: 'gene-fix-agent', podId: GATED_POD },
        { tgMessageId: '102', agentUsername: 'lead-agent', podId: ORIGINAL_POD },
        { tgMessageId: '103', agentUsername: 'legacy-agent' },
      ],
      ...overrides,
    },
  });
  const podDoc = (overrides = {}) => ({ name: 'Alpha', type: 'team', members: ['user-1'], ...overrides });

  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    Pod.findById.mockImplementation((id) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(
          String(id) === GATED_POD ? podDoc({ name: 'Launch' }) : podDoc(),
        ),
      }),
    }));
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ username: 'sam' }) }),
    });
    PGMessage.create.mockResolvedValue({ id: 'pg-1' });
    PGMessage.findById.mockResolvedValue({ id: 'pg-1', content: 'relayed' });
    deliverMessageToAgents.mockResolvedValue(undefined);
    telegramSend.sendMessage.mockResolvedValue({ success: true, messageId: 555 });
    IntegrationModel.findByIdAndUpdate.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  });

  const inbound = (integration, message) => relayTelegramMessageToPod({
    integration,
    telegramMessage: { text: 'looks wrong', ...message },
  });

  it('returns the quoted line\'s pod, and null for an entry that predates it', () => {
    const integration = userScoped();
    const relayMap = integration.config.relayMap;
    expect(routeReplyContent({
      content: 'use the v2 schema', replyToTgMessageId: '101', relayMap,
    }).podId).toBe(GATED_POD);
    expect(routeReplyContent({
      content: 'use the v2 schema', replyToTgMessageId: '103', relayMap,
    }).podId).toBeNull();
  });

  it('tags the outbound line with the pod name and records the pod in the map', async () => {
    await relayAgentMessageToTelegram({
      podId: GATED_POD,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: 'deploy is green',
      podMessageId: 'pm-1',
      integration: userScoped({ relayAllAgentMessages: true }),
    });

    const [, , text] = telegramSend.sendMessage.mock.calls[0];
    expect(text).toContain('[Launch]');
    expect(IntegrationModel.findByIdAndUpdate).toHaveBeenCalledWith('i1', expect.objectContaining({
      $push: expect.objectContaining({
        'config.relayMap': expect.objectContaining({
          $each: [expect.objectContaining({ podId: GATED_POD, tgMessageId: '555' })],
        }),
      }),
    }));
  });

  it('posts a quote-reply into the quoted pod, not the active one', async () => {
    const result = await inbound(userScoped(), { reply_to_message: { message_id: 101 } });

    expect(result).toEqual({ relayed: true, routedAgent: 'gene-fix-agent' });
    expect(PGMessage.create).toHaveBeenCalledTimes(1);
    expect(PGMessage.create.mock.calls[0][0]).toBe(GATED_POD);
  });

  it('still posts an unquoted message to the active pod', async () => {
    await inbound(userScoped(), {});

    expect(PGMessage.create.mock.calls[0][0]).toBe(ORIGINAL_POD);
  });

  it('keeps a quote-reply to the active pod\'s own line on the active pod, gate off', async () => {
    // The `:184` rule: inbound never consults the active pod's gate. Routing a
    // reply to the pod it already belongs in must not add that requirement.
    await inbound(userScoped(), { reply_to_message: { message_id: 102 } });

    expect(PGMessage.create.mock.calls[0][0]).toBe(ORIGINAL_POD);
    expect(telegramSend.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a quote-reply into a pod whose gate is off, naming it, posting nothing', async () => {
    const integration = userScoped({ gates: {} });
    const result = await inbound(integration, { reply_to_message: { message_id: 101 } });

    expect(result).toEqual({ relayed: false });
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(deliverMessageToAgents).not.toHaveBeenCalled();
    expect(telegramSend.sendMessage).toHaveBeenCalledTimes(1);
    const [, , text] = telegramSend.sendMessage.mock.calls[0];
    expect(text).toContain('Launch');
    expect(text).toContain('Nothing was posted');
  });

  it('refuses a quote-reply into a pod the linked user has left', async () => {
    Pod.findById.mockImplementation((id) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(
          String(id) === GATED_POD ? podDoc({ name: 'Launch', members: [] }) : podDoc(),
        ),
      }),
    }));
    const result = await inbound(userScoped(), { reply_to_message: { message_id: 101 } });

    expect(result).toEqual({ relayed: false });
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(telegramSend.sendMessage.mock.calls[0][2]).toContain('Launch');
  });

  it('routes an entry with no podId as it always has — the active pod', async () => {
    await inbound(userScoped(), { reply_to_message: { message_id: 103 } });

    expect(PGMessage.create.mock.calls[0][0]).toBe(ORIGINAL_POD);
  });
});
