const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const Summary = require('../../../models/Summary');
const AgentIdentityService = require('../../../services/agentIdentityService');
const PodAssetService = require('../../../services/podAssetService');
const socketConfig = require('../../../config/socket');
const DMService = require('../../../services/dmService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');

jest.mock('../../../models/Message');
jest.mock('../../../models/Summary', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));
jest.mock('../../../services/podAssetService', () => ({
  createChatSummaryAsset: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  resolveAgentOwner: jest.fn(),
  getOrCreateAgentDM: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    })),
  },
}));
jest.mock('../../../models/User', () => ({
  find: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  })),
}));

describe('AgentMessageService summary persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([]);
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({
      _id: 'agent-user-1',
      username: 'commonly-bot',
      profilePicture: 'default',
    });
    AgentIdentityService.ensureAgentInPod.mockResolvedValue({ _id: 'pod-1' });
    socketConfig.getIO.mockReturnValue({
      to: () => ({ emit: jest.fn() }),
    });
    Message.mockImplementation(function MockMessage(doc) {
      return {
        ...doc,
        _id: 'msg-1',
        createdAt: new Date(),
        save: jest.fn().mockResolvedValue(true),
        populate: jest.fn().mockResolvedValue(this),
      };
    });
    DMService.resolveAgentOwner.mockResolvedValue(null);
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    process.env.AGENT_HEARTBEAT_HOUSEKEEPING_FALLBACK = '1';
  });

  afterEach(() => {
    if (AgentMessageService.getRecentMessages.mockRestore) {
      AgentMessageService.getRecentMessages.mockRestore();
    }
  });

  it('persists summary from BOT_MESSAGE content', async () => {
    Summary.findOne.mockResolvedValue(null);
    Summary.create.mockResolvedValue({ _id: 'sum-1', type: 'chats' });
    PodAssetService.createChatSummaryAsset.mockResolvedValue({});

    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      podId: 'pod-1',
      content: '[BOT_MESSAGE]{"type":"integration-summary","summary":"Top updates","messageCount":4}',
      metadata: { eventId: 'evt-1', source: 'integration' },
    });

    expect(Summary.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chats',
      podId: 'pod-1',
      content: 'Top updates',
    }));
    expect(result.summary).toEqual({ id: 'sum-1', type: 'chats' });
  });

  it('skips duplicate summary persistence for same eventId', async () => {
    Summary.findOne.mockResolvedValue({ _id: 'sum-existing', type: 'chats' });

    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      podId: 'pod-1',
      content: '[BOT_MESSAGE]{"type":"integration-summary","summary":"Top updates","messageCount":4}',
      metadata: { eventId: 'evt-dup', source: 'integration' },
    });

    expect(Summary.create).not.toHaveBeenCalled();
    expect(result.summary).toEqual({ id: 'sum-existing', type: 'chats' });
  });

  it('skips duplicate recent heartbeat-style messages when heartbeat dedupe is configured', async () => {
    const previousHeartbeatDedupe = process.env.AGENT_HEARTBEAT_MESSAGE_DEDUPE_MINUTES;
    process.env.AGENT_HEARTBEAT_MESSAGE_DEDUPE_MINUTES = '180';
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([
      {
        id: 'msg-existing',
        content: '@liz Same heartbeat update text',
        createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
        userId: { _id: 'agent-user-1' },
      },
    ]);

    const result = await AgentMessageService.postMessage({
      agentName: 'socialpulse',
      instanceId: 'default',
      podId: 'pod-1',
      content: '@liz Same heartbeat update text',
      metadata: { sourceEventType: 'heartbeat' },
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('duplicate_recent');
    expect(Message).not.toHaveBeenCalled();

    AgentMessageService.getRecentMessages.mockRestore();
    if (typeof previousHeartbeatDedupe === 'undefined') {
      delete process.env.AGENT_HEARTBEAT_MESSAGE_DEDUPE_MINUTES;
    } else {
      process.env.AGENT_HEARTBEAT_MESSAGE_DEDUPE_MINUTES = previousHeartbeatDedupe;
    }
  });

  it('routes likely error content to agent-admin DM and posts system notice', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      instanceId: 'default',
      podId: 'pod-1',
      content: 'ERROR: failed to fetch external feed (429 status response)',
      metadata: { sourceEventId: 'evt-err-1' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      routedToDM: true,
      dmPodId: 'dm-pod-1',
    }));
    expect(DMService.resolveAgentOwner).toHaveBeenCalledWith('commonly-bot', 'pod-1', 'default');
    expect(DMService.getOrCreateAgentDM).toHaveBeenCalledWith(
      'agent-user-1',
      'owner-user-1',
      expect.objectContaining({ agentName: 'commonly-bot', instanceId: 'default' }),
    );

    // First write is full error to DM pod, second write is system notice in source pod.
    expect(Message).toHaveBeenCalledTimes(2);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'dm-pod-1',
      messageType: 'text',
    }));
    expect(Message.mock.calls[1][0]).toEqual(expect.objectContaining({
      podId: 'pod-1',
      messageType: 'system',
    }));
  });

  it('does not route error-like content to DM when owner DM routing is disabled', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      instanceId: 'default',
      podId: 'pod-1',
      content: 'ERROR: failed to fetch external feed (429 status response)',
      metadata: { sourceEventId: 'evt-err-2' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(result.routedToDM).toBeUndefined();
    expect(DMService.resolveAgentOwner).not.toHaveBeenCalled();
    expect(DMService.getOrCreateAgentDM).not.toHaveBeenCalled();
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'pod-1',
      messageType: 'text',
    }));
  });

  it('routes unknown-target send failures to DM when owner DM routing is enabled', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'tarik',
      podId: 'pod-1',
      content: 'Message: send failed: Unknown target "commonly:pod-1" for Commonly.',
      metadata: { sourceEventType: 'chat.mention', sourceEventId: 'evt-err-unknown-target' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      routedToDM: true,
      dmPodId: 'dm-pod-1',
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'dm-pod-1',
      messageType: 'text',
    }));
  });

  it('suppresses heartbeat housekeeping messages in pod chat', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'tom' },
        { instanceId: 'liz' },
      ]),
    });

    const result = await AgentMessageService.postMessage({
      agentName: 'x-curator',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: 'No meaningful new signals detected for pod pod-1. Heartbeat check complete with no new activity to report.',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-housekeeping' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('@liz');
    expect(Message.mock.calls[0][0].content).toContain('@tom');
  });

  it('suppresses bare HEARTBEAT_OK control-token messages in pod chat', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'tarik' },
      ]),
    });

    const result = await AgentMessageService.postMessage({
      agentName: 'tom',
      instanceId: 'tom',
      podId: 'pod-1',
      content: 'HEARTBEAT_OK',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-token' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('@tarik');
  });

  it('rewrites low-value heartbeat replies into meaningful fallback updates', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'liz' },
      ]),
    });
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([
      {
        id: 'msg-human-1',
        content: 'We should prioritize reconnecting x-curator to fetch real X feed items.',
        messageType: 'text',
        userId: { _id: 'user-22', username: 'tarik-human' },
      },
    ]);

    const result = await AgentMessageService.postMessage({
      agentName: 'tom',
      instanceId: 'tom',
      podId: 'pod-1',
      content: '@liz ok',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-low-value' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('latest pod activity');
    expect(Message.mock.calls[0][0].content).toContain('reconnecting x-curator');
    expect(Message.mock.calls[0][0].metadata).toEqual(expect.objectContaining({
      heartbeatFallbackPosted: true,
      heartbeatFallbackReason: 'low_value',
    }));
  });

  it('uses no-activity fallback wording when there is no meaningful recent signal', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'tarik' },
      ]),
    });
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([
      {
        id: 'msg-ack-1',
        content: 'ok',
        messageType: 'text',
        userId: { _id: 'user-33', username: 'someone' },
      },
    ]);

    const result = await AgentMessageService.postMessage({
      agentName: 'tom',
      instanceId: 'tom',
      podId: 'pod-1',
      content: '@tarik ok',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-low-value-no-signal' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('no new meaningful pod activity in the latest scan');
  });

  it('can use meaningful activity from another agent as fallback signal', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'liz' },
      ]),
    });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: 'agent-liz-id', isBot: true },
      ]),
    });
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([
      {
        id: 'msg-agent-1',
        content: 'New X post from @ign: Steam Deck OLED stock normalized and discounts are live.',
        messageType: 'text',
        userId: { _id: 'agent-liz-id', username: 'openclaw-liz' },
      },
    ]);

    const result = await AgentMessageService.postMessage({
      agentName: 'tom',
      instanceId: 'tom',
      podId: 'pod-1',
      content: '@liz ok',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-low-value-agent-signal' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('latest pod activity');
    expect(Message.mock.calls[0][0].content).toContain('Steam Deck OLED stock normalized');
  });

  it('ignores summarizer payloads and prior heartbeat loop text when selecting fallback signal', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'liz' },
      ]),
    });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: 'summarizer-id', isBot: true },
        { _id: 'agent-liz-id', isBot: true },
      ]),
    });
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([
      {
        id: 'msg-1',
        content: '[BOT_MESSAGE]{"type":"chat-summary","summary":"..."}',
        messageType: 'text',
        userId: { _id: 'summarizer-id', username: 'Commonly Summarizer' },
      },
      {
        id: 'msg-2',
        content: '@liz heartbeat update: latest pod activity from @tom: "older fallback..."',
        messageType: 'text',
        userId: { _id: 'agent-liz-id', username: 'openclaw-liz' },
      },
      {
        id: 'msg-3',
        content: 'Meaningful update: Team decided to ship the API retry patch today.',
        messageType: 'text',
        userId: { _id: 'human-1', username: 'xcjsam' },
      },
    ]);

    const result = await AgentMessageService.postMessage({
      agentName: 'tom',
      instanceId: 'tom',
      podId: 'pod-1',
      content: '@liz ok',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-loop-filter' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('Meaningful update: Team decided to ship the API retry patch today.');
    expect(Message.mock.calls[0][0].content).not.toContain('[BOT_MESSAGE]');
    expect(Message.mock.calls[0][0].content).not.toContain('older fallback');
  });

  it('can disable heartbeat housekeeping fallback and keep suppression behavior', async () => {
    process.env.AGENT_HEARTBEAT_HOUSEKEEPING_FALLBACK = '0';
    const result = await AgentMessageService.postMessage({
      agentName: 'tom',
      instanceId: 'tom',
      podId: 'pod-1',
      content: 'HEARTBEAT_OK',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-token-off' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses heartbeat diagnostics in pod chat when owner DM routing is disabled', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'liz' },
      ]),
    });

    const result = await AgentMessageService.postMessage({
      agentName: 'tarik',
      instanceId: 'tarik',
      podId: 'pod-1',
      content: 'The Commonly pod service is not running. I am unable to get the pod activity.',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-diagnostic' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(DMService.resolveAgentOwner).not.toHaveBeenCalled();
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('@liz');
  });

  it('routes heartbeat diagnostics to DM without posting source-pod notice when owner DM routing is enabled', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'tarik',
      instanceId: 'tarik',
      podId: 'pod-1',
      content: 'The Commonly pod service is still not running. I am unable to get the pod activity.',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-dm' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      routedToDM: true,
      dmPodId: 'dm-pod-1',
    }));
    expect(DMService.resolveAgentOwner).toHaveBeenCalledWith('tarik', 'pod-1', 'tarik');
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'dm-pod-1',
      messageType: 'text',
    }));
  });

  it('suppresses heartbeat-like diagnostic text even without heartbeat metadata', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: 'The Commonly pod service is not running. I am unable to get the pod activity.',
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_diagnostic_suppressed',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw heartbeat-like housekeeping chatter variants without heartbeat metadata', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: "I've triggered the heartbeat check for pod pod-1. I'll now check the current activity.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw heartbeat-like api access diagnostics variants', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: "I'm unable to access the pod's activity data through the available API endpoints. The requests are returning errors, which suggests there may be an authentication issue.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_diagnostic_suppressed',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw runtime-api narration variants without heartbeat metadata', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'tarik',
      podId: 'pod-1',
      content: 'I need to check the actual pod activity rather than search results. Let me use the proper runtime API to get the pod context and messages.',
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses heartbeat progress narration templates and posts fallback instead', async () => {
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { instanceId: 'tarik' },
      ]),
    });
    jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([]);

    const result = await AgentMessageService.postMessage({
      agentName: 'liz',
      instanceId: 'liz',
      podId: 'pod-1',
      content: '@tom @liz @x-curator Looking at the last 8 messages and 4 recent posts...',
      metadata: { sourceEventType: 'heartbeat', sourceEventId: 'evt-hb-progress-template' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fallbackPosted: true,
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0].content).toContain('heartbeat check-in');
    expect(Message.mock.calls[0][0].content).toContain('@x-curator');
  });

  it('routes openclaw persistent pod-access diagnostics to DM when owner routing is enabled', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      content: "I am unable to retrieve any meaningful new signals from pod pod-1 at this time. The API calls to fetch context and messages are consistently failing, indicating a persistent issue with accessing the pod's data.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      routedToDM: true,
      dmPodId: 'dm-pod-1',
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'dm-pod-1',
      messageType: 'text',
    }));
  });

  it('suppresses openclaw current-pod-check narration variants', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: "I'll check the current pod activity for pod pod-1 and report back only if there's meaningful new signal.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw localhost runtime-call chatter variants', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: 'curl -s "http://localhost:3000/api/agents/runtime/pods/pod-1/messages?limit=8" || echo "messages_failed"',
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw tool-clarification heartbeat questions', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      content: 'Could you please specify which tool I should use to access the "payload.activityHint" and "current pod activity" before I decide whether to return "HEARTBEAT_OK"?',
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw pre-check narration about deciding whether to post', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: "Since I can't access the current activity, I'll check if there's been recent activity before deciding whether to post.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw no-activity heartbeat chatter variants', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'tom',
      podId: 'pod-1',
      content: 'No activity detected on pod pod-1. Returning HEARTBEAT_OK.',
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_housekeeping',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('suppresses openclaw tool-mismatch pod-context diagnostics variants', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'tarik',
      podId: 'pod-1',
      content: 'I encountered a permission error when trying to access the pod context. I need to use the correct tool because this is not a valid channel ID.',
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'heartbeat_diagnostic_suppressed',
    }));
    expect(Message).not.toHaveBeenCalled();
  });

  it('routes openclaw no-activity-hint diagnostics to DM when owner routing is enabled', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: "I'm unable to access the Commonly pod with ID pod-1. Since I can't determine the current activity state and there's no activity hint in the payload to check for recent activity, I'll follow the safety protocol and not post anything.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      routedToDM: true,
      dmPodId: 'dm-pod-1',
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'dm-pod-1',
      messageType: 'text',
    }));
  });

  it('routes openclaw unsupported-channel diagnostics to DM when owner routing is enabled', async () => {
    DMService.resolveAgentOwner.mockResolvedValue('owner-user-1');
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1' });

    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      podId: 'pod-1',
      content: "I'm unable to access the pod activity for pod pod-1. The Commonly channel configuration doesn't support the operations I need to check recent activity in that specific pod.",
      metadata: {},
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      routedToDM: true,
      dmPodId: 'dm-pod-1',
    }));
    expect(Message).toHaveBeenCalledTimes(1);
    expect(Message.mock.calls[0][0]).toEqual(expect.objectContaining({
      podId: 'dm-pod-1',
      messageType: 'text',
    }));
  });

  it('does not suppress non-heartbeat commonly-bot content when metadata is missing', async () => {
    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      instanceId: 'default',
      podId: 'pod-1',
      content: 'No meaningful new signals detected for this run.',
      metadata: { sourceEventType: 'summary.request' },
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: false } },
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
    }));
    expect(result.skipped).toBeUndefined();
    expect(Message).toHaveBeenCalledTimes(1);
  });
});
