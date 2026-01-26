// Mock Discord.js before importing anything else
jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue('logged_in'),
    on: jest.fn(),
    guilds: {
      fetch: jest.fn(),
    },
    channels: {
      fetch: jest.fn(),
    },
  })),
  GatewayIntentBits: {
    Guilds: 'Guilds',
    GuildMessages: 'GuildMessages',
    GuildWebhooks: 'GuildWebhooks',
  },
}));

// Mock models
jest.mock('../../../models/Integration');
jest.mock('../../../models/DiscordIntegration', () => ({
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/DiscordSummaryHistory', () => jest.fn().mockImplementation(() => ({
  save: jest.fn(),
})));
jest.mock('../../../services/discordCommandService');
jest.mock('../../../services/commonlyBotService');
jest.mock('../../../config/discord');
jest.mock('axios');

const axios = require('axios');
const DiscordService = require('../../../services/discordService');
const Integration = require('../../../models/Integration');
const DiscordCommandService = require('../../../services/discordCommandService');
const CommonlyBotService = require('../../../services/commonlyBotService');

// Mock the Discord config
jest.mock('../../../config/discord', () => ({
  botToken: 'test-bot-token',
  clientId: 'test-client-id',
  applicationId: 'test-app-id',
}));

describe('DiscordService', () => {
  let discordService;
  let mockIntegration;
  let mockCommandService;
  let mockCommonlyBotService;

  beforeEach(() => {
    // Mock integration data
    mockIntegration = {
      _id: 'integration123',
      podId: 'pod123',
      config: {
        channelId: 'channel123',
        serverId: 'guild123',
        webhookListenerEnabled: true,
      },
      platformIntegration: {
        serverId: 'guild123',
        channelId: 'channel123',
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      },
    };

    // Mock Integration model
    Integration.findById = jest.fn().mockReturnValue({
      populate: jest.fn().mockResolvedValue(mockIntegration),
      lean: jest.fn().mockResolvedValue(mockIntegration),
    });
    Integration.findByIdAndUpdate = jest
      .fn()
      .mockResolvedValue(mockIntegration);

    // Mock DiscordCommandService
    mockCommandService = {
      initialize: jest.fn().mockResolvedValue(true),
      createDiscordSummary: jest.fn().mockImplementation((messages, start, end) => (
        Promise.resolve({
          content: 'Test summary',
          messageCount: messages.length,
          timeRange: { start, end },
        })
      )),
    };
    DiscordCommandService.mockImplementation(() => mockCommandService);

    // Mock CommonlyBotService
    mockCommonlyBotService = {
      postDiscordSummaryToPod: jest.fn().mockResolvedValue({
        success: true,
        message: { id: 'msg123' },
      }),
    };
    CommonlyBotService.mockImplementation(() => mockCommonlyBotService);

    // Mock axios
    axios.get = jest.fn();
    axios.put = jest.fn();
    axios.post = jest.fn();

    discordService = new DiscordService('integration123');
    discordService.integration = mockIntegration;
    discordService.ensureClientReady = jest.fn().mockResolvedValue(true);

    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully with valid integration', async () => {
      const result = await discordService.initialize();
      expect(result).toBe(true);
      expect(Integration.findById).toHaveBeenCalledWith('integration123');
      expect(DiscordCommandService).toHaveBeenCalledWith(
        expect.objectContaining({
          guildId: 'guild123',
          channelId: 'channel123',
          integrationId: 'integration123',
        }),
      );
    });

    it('should fail initialization with invalid integration', async () => {
      Integration.findById = jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await discordService.initialize();
      expect(result).toBe(false);
    });
  });

  describe('connect', () => {
    beforeEach(() => {
      discordService.client = {
        guilds: {
          fetch: jest.fn().mockResolvedValue({
            channels: {
              fetch: jest.fn().mockResolvedValue({ id: 'channel123' }),
            },
          }),
        },
      };
    });

    it('should connect to Discord successfully', async () => {
      const result = await discordService.connect();
      expect(result).toBe(true);
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        'integration123',
        {
          status: 'connected',
          lastSync: expect.any(Date),
        },
      );
    });

    it('should handle connection errors', async () => {
      discordService.client.guilds.fetch.mockRejectedValue(
        new Error('Guild not found'),
      );

      const result = await discordService.connect();
      expect(result).toBe(false);
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        'integration123',
        {
          status: 'error',
          lastError: 'Guild not found',
        },
      );
    });
  });

  describe('disconnect', () => {
    it('should disconnect from Discord', async () => {
      const result = await discordService.disconnect();
      expect(result).toBe(true);
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        'integration123',
        {
          status: 'disconnected',
          lastSync: expect.any(Date),
        },
      );
    });

    it('should handle disconnect errors gracefully', async () => {
      Integration.findByIdAndUpdate.mockRejectedValue(
        new Error('Database error'),
      );

      const result = await discordService.disconnect();
      expect(result).toBe(false);
    });
  });

  describe('syncRecentMessages', () => {
    beforeEach(() => {
      // Mock fetchMessages method
      discordService.fetchMessages = jest.fn();
      discordService.commandService = mockCommandService;
    });

    it('should sync messages successfully', async () => {
      const mockMessages = [
        {
          messageId: 'msg1',
          content: 'Hello world',
          authorName: 'user1',
          timestamp: new Date(),
        },
        {
          messageId: 'msg2',
          content: 'How are you?',
          authorName: 'user2',
          timestamp: new Date(),
        },
      ];

      Integration.findById = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ...mockIntegration,
          config: {
            ...mockIntegration.config,
            messageBuffer: mockMessages,
          },
        }),
      });

      const result = await discordService.syncRecentMessages(1);

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      expect(
        mockCommonlyBotService.postDiscordSummaryToPod,
      ).toHaveBeenCalledWith(
        'pod123',
        expect.objectContaining({
          content: 'Test summary',
        }),
        'integration123',
      );
    });

    it('should return early when sync is disabled', async () => {
      discordService.integration.config.webhookListenerEnabled = false;

      const result = await discordService.syncRecentMessages(1);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Discord sync not enabled');
    });

    it('should return early if no messages found', async () => {
      Integration.findById = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ...mockIntegration,
          config: {
            ...mockIntegration.config,
            messageBuffer: [],
          },
        }),
      });

      const result = await discordService.syncRecentMessages(1);

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(0);
      expect(
        mockCommonlyBotService.postDiscordSummaryToPod,
      ).not.toHaveBeenCalled();
    });

    it('should handle bot service errors gracefully', async () => {
      const mockMessages = [
        {
          messageId: 'msg1',
          content: 'Test message',
          authorName: 'user1',
          timestamp: new Date(),
        },
      ];
      Integration.findById = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ...mockIntegration,
          config: {
            ...mockIntegration.config,
            messageBuffer: mockMessages,
          },
        }),
      });
      mockCommonlyBotService.postDiscordSummaryToPod.mockResolvedValue({
        success: false,
        error: 'Failed to post',
      });

      const result = await discordService.syncRecentMessages(1);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Failed to post Discord summary');
    });

    it('should set time range from buffered messages', async () => {
      const now = new Date();
      const oldMessage = {
        messageId: 'msg1',
        content: 'Old message',
        authorName: 'user1',
        timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
      };
      const recentMessage = {
        messageId: 'msg2',
        content: 'Recent message',
        authorName: 'user2',
        timestamp: now,
      };
      Integration.findById = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ...mockIntegration,
          config: {
            ...mockIntegration.config,
            messageBuffer: [oldMessage, recentMessage],
          },
        }),
      });

      const result = await discordService.syncRecentMessages(1); // 1 hour range

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      expect(mockCommonlyBotService.postDiscordSummaryToPod).toHaveBeenCalledWith(
        'pod123',
        expect.objectContaining({
          timeRange: expect.objectContaining({
            start: oldMessage.timestamp,
            end: recentMessage.timestamp,
          }),
        }),
        'integration123',
      );
    });

    it('should handle fetch errors gracefully', async () => {
      Integration.findById = jest.fn().mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error('DB error')),
      });

      const result = await discordService.syncRecentMessages(1);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Failed to sync Discord messages');
    });
  });

  describe('fetchMessages', () => {
    it('should fetch messages from Discord API', async () => {
      const mockApiResponse = {
        data: [
          {
            id: 'msg1',
            content: 'Hello',
            author: { username: 'user1', bot: false },
            timestamp: new Date().toISOString(),
            attachments: [],
            embeds: [],
          },
        ],
      };

      axios.get.mockResolvedValue(mockApiResponse);

      const result = await discordService.fetchMessages({ limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0].author).toBe('user1');
      expect(axios.get).toHaveBeenCalledWith(
        'https://discord.com/api/v10/channels/channel123/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          }),
        }),
      );
    });

    it('should handle API errors', async () => {
      axios.get.mockRejectedValue(new Error('API error'));

      await expect(discordService.fetchMessages()).rejects.toThrow('API error');
    });
  });

  describe('registerSlashCommands', () => {
    it('should register commands successfully', async () => {
      axios.put.mockResolvedValue({ status: 200 });

      const result = await discordService.registerSlashCommands('guild123');

      expect(result).toBe(true);
      expect(axios.put).toHaveBeenCalled();
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        'integration123',
        {
          'config.commandsRegistered': true,
          'config.lastCommandRegistration': expect.any(Date),
          'config.registeredGuildId': 'guild123',
        },
      );
    });

    it('should handle registration failures', async () => {
      axios.put.mockResolvedValue({ status: 500 });

      const result = await discordService.registerSlashCommands('guild123');

      expect(result).toBe(false);
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        'integration123',
        {
          'config.commandsRegistered': false,
          'config.lastRegistrationError': expect.any(String),
          'config.lastRegistrationAttempt': expect.any(Date),
        },
      );
    });
  });
});
