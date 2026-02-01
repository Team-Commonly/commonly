jest.mock('../../models/Integration', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../services/integrationSummaryService', () => ({ createSummary: jest.fn() }));
jest.mock('../../services/groupmeService', () => ({ sendMessage: jest.fn() }));

jest.mock('../../services/discordService', () => {
  const validateConfig = jest.fn().mockResolvedValue({ ok: true });
  const handleWebhook = jest.fn().mockResolvedValue({ ok: true });
  const initialize = jest.fn().mockResolvedValue(undefined);
  const syncRecentMessages = jest.fn().mockResolvedValue({
    success: true,
    messageCount: 0,
    messages: [],
    content: 'mock sync',
  });
  const ensureClientReady = jest.fn().mockResolvedValue(undefined);

  const DiscordService = jest.fn().mockImplementation(() => ({
    handleWebhook,
    initialize,
    syncRecentMessages,
    ensureClientReady,
  }));
  DiscordService.validateConfig = validateConfig;

  return DiscordService;
});

const registry = require('../../integrations');
const { manifests } = require('../../integrations/manifests');

let validateNormalizedMessage;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ validateNormalizedMessage } = require('../../../packages/integration-sdk/src/manifest'));
} catch (err) {
  validateNormalizedMessage = (message) => {
    const requiredStringFields = [
      'source',
      'externalId',
      'authorId',
      'authorName',
      'content',
      'timestamp',
    ];
    const errors = [];
    requiredStringFields.forEach((field) => {
      if (!message?.[field] || typeof message[field] !== 'string') {
        errors.push(`missing string field: ${field}`);
      }
    });
    return errors;
  };
}

const requiredMethods = [
  'validateConfig',
  'getWebhookHandlers',
  'ingestEvent',
  'syncRecent',
  'health',
];

const minimalConfigByType = {
  discord: {
    serverId: 'server-1',
    channelId: 'channel-1',
    botToken: 'token-1',
  },
  slack: {
    botToken: 'xoxb-token',
    signingSecret: 'secret',
    channelId: 'C123',
  },
  groupme: {
    botId: 'bot-1',
    groupId: 'group-1',
  },
  telegram: {
    chatId: 'chat-1',
  },
  x: {
    accessToken: 'x-token',
    username: 'openclaw',
  },
  instagram: {
    accessToken: 'ig-token',
    igUserId: 'ig-user-1',
  },
};

const payloadByType = {
  discord: {
    type: 0,
    data: { id: 'noop' },
  },
  slack: {
    event: {
      type: 'message',
      user: 'U123',
      text: 'hello from slack',
      channel: 'C123',
      ts: '1700000000.000100',
      client_msg_id: 'm-1',
    },
  },
  groupme: {
    id: 'gm-1',
    group_id: 'group-1',
    sender_type: 'user',
    name: 'Sam',
    user_id: 'user-1',
    text: 'hello from groupme',
    created_at: 1700000000,
    attachments: [],
  },
  telegram: {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1700000000,
      text: 'hello from telegram',
      chat: { id: 999, type: 'group', title: 'Test Chat' },
      from: { id: 123, is_bot: false, first_name: 'Sam' },
    },
  },
  x: {
    data: [
      {
        id: 'tweet-1',
        text: 'hello from x',
        author_id: 'user-1',
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ],
    user: { id: 'user-1', username: 'openclaw', name: 'OpenClaw' },
  },
  instagram: {
    data: [
      {
        id: 'ig-1',
        caption: 'hello from instagram',
        media_type: 'IMAGE',
        media_url: 'https://example.com/image.jpg',
        permalink: 'https://instagram.com/p/abc',
        timestamp: '2025-01-01T00:00:00.000Z',
        username: 'openclaw',
      },
    ],
  },
};

function buildIntegration(type, config) {
  return {
    _id: `${type}-integration-1`,
    podId: 'pod-1',
    type,
    config,
    platformIntegration: null,
  };
}

const manifestTypes = Object.keys(manifests);

describe('integration provider contract', () => {
  it('registers a provider factory for every manifest', () => {
    const registeredTypes = new Set(registry.providers.keys());
    manifestTypes.forEach((type) => {
      expect(registeredTypes.has(type)).toBe(true);
    });
  });

  it('each provider exposes the required methods', async () => {
    await Promise.all(manifestTypes.map(async (type) => {
      const integration = buildIntegration(type, minimalConfigByType[type]);
      const provider = registry.get(type, integration);
      requiredMethods.forEach((method) => {
        expect(typeof provider[method]).toBe('function');
      });
    }));
  });

  it('validateConfig rejects missing required fields', async () => {
    await Promise.all(manifestTypes.map(async (type) => {
      const integration = buildIntegration(type, {});
      const provider = registry.get(type, integration);
      await expect(provider.validateConfig()).rejects.toThrow();
    }));
  });

  it('validateConfig accepts the minimal required config', async () => {
    await Promise.all(manifestTypes.map(async (type) => {
      const integration = buildIntegration(type, minimalConfigByType[type]);
      const provider = registry.get(type, integration);
      await expect(provider.validateConfig()).resolves.toBeUndefined();
    }));
  });

  it('ingestEvent returns normalized messages when present', async () => {
    await Promise.all(manifestTypes.map(async (type) => {
      const integration = buildIntegration(type, minimalConfigByType[type]);
      const provider = registry.get(type, integration);
      const payload = payloadByType[type];
      const messages = await provider.ingestEvent(payload);
      expect(Array.isArray(messages)).toBe(true);
      messages.forEach((message) => {
        const errors = validateNormalizedMessage(message);
        expect(errors).toEqual([]);
      });
    }));
  });
});
