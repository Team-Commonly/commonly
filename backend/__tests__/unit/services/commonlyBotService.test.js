const CommonlyBotService = require('../../../services/commonlyBotService');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');

// Mock external dependencies
jest.mock('../../../models/User');
jest.mock('../../../models/Pod');
jest.mock('../../../models/pg/Message');
jest.mock('../../../config/socket');
jest.mock('../../../config/db-pg');

const PGMessage = require('../../../models/pg/Message');
const socketConfig = require('../../../config/socket');

describe('CommonlyBotService', () => {
  let botService;
  let mockBot;
  let mockPod;

  beforeEach(() => {
    botService = new CommonlyBotService();

    mockBot = {
      _id: 'bot123',
      username: 'commonly-bot',
      email: 'bot@commonly.app',
      profilePicture: 'purple',
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };

    mockPod = {
      _id: 'pod123',
      name: 'Test Pod',
      members: ['user1'],
      save: jest.fn().mockResolvedValue(true),
    };

    jest.clearAllMocks();
  });

  describe('getBotUser', () => {
    it('should return existing bot user', async () => {
      User.findOne.mockResolvedValue(mockBot);

      const result = await botService.getBotUser();

      expect(result).toBe(mockBot);
      expect(User.findOne).toHaveBeenCalledWith({ username: 'commonly-bot' });
    });

    it('should create new bot user if not exists', async () => {
      User.findOne.mockResolvedValue(null);
      User.prototype.save = jest.fn().mockResolvedValue(mockBot);

      const result = await botService.getBotUser();

      expect(User).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'commonly-bot',
          email: 'bot@commonly.app',
          profilePicture: 'purple',
        }),
      );
    });
  });

  describe('postDiscordSummaryToPod', () => {
    beforeEach(() => {
      User.findOne.mockResolvedValue(mockBot);
      Pod.findById.mockResolvedValue(mockPod);

      // Mock PostgreSQL message creation
      PGMessage.create.mockResolvedValue({
        id: 'msg123',
        content: 'test message',
        message_type: 'text',
        created_at: new Date(),
      });

      // Mock socket
      const mockIo = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };
      socketConfig.getIO.mockReturnValue(mockIo);

      // Mock PostgreSQL pool
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      };
      require('../../../config/db-pg').pool = mockPool;

      // Mock process.env
      process.env.PG_HOST = 'localhost';
    });

    it('should post Discord summary to pod successfully', async () => {
      const discordSummary = {
        content: 'Test summary content',
        messageCount: 5,
        serverName: 'Test Server',
        channelName: 'general',
      };

      const result = await botService.postDiscordSummaryToPod(
        'pod123',
        discordSummary,
        'integration123',
      );

      expect(result.success).toBe(true);
      expect(Pod.findById).toHaveBeenCalledWith('pod123');
      expect(PGMessage.create).toHaveBeenCalledWith(
        'pod123',
        'bot123',
        expect.stringContaining('Discord Update from #general'),
        'text',
      );
    });

    it('should add bot to pod members if not already member', async () => {
      mockPod.members = ['other-user']; // Bot not in members

      const discordSummary = {
        content: 'Test summary',
        messageCount: 3,
      };

      await botService.postDiscordSummaryToPod(
        'pod123',
        discordSummary,
        'integration123',
      );

      expect(mockPod.members).toContain('bot123');
      expect(mockPod.save).toHaveBeenCalled();
    });

    it('should return error if pod not found', async () => {
      Pod.findById.mockResolvedValue(null);

      const result = await botService.postDiscordSummaryToPod(
        'invalid-pod',
        {},
        'integration123',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pod invalid-pod not found');
    });

    it('should format Discord summary message correctly', async () => {
      const discordSummary = {
        content: 'Great discussion about React',
        messageCount: 10,
        serverName: 'Dev Community',
        channelName: 'react-help',
        timeRange: {
          start: '2023-07-14T10:00:00Z',
          end: '2023-07-14T11:00:00Z',
        },
      };

      await botService.postDiscordSummaryToPod(
        'pod123',
        discordSummary,
        'integration123',
      );

      const [, , messageContent] = PGMessage.create.mock.calls[0];
      expect(messageContent).toContain('🎮 Discord Update from #react-help');
      expect(messageContent).toContain('💬 10 messages in Dev Community');
      expect(messageContent).toContain('Great discussion about React');
      expect(messageContent).toContain('—Commonly Bot 🤖');
    });
  });

  describe('syncBotUserToPostgreSQL', () => {
    beforeEach(() => {
      const mockPool = {
        query: jest.fn(),
      };
      require('../../../config/db-pg').pool = mockPool;
      process.env.PG_HOST = 'localhost';
    });

    it('should sync bot user to PostgreSQL if not exists', async () => {
      const mockPool = require('../../../config/db-pg').pool;
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // User doesn't exist
        .mockResolvedValueOnce({ rows: [{ _id: 'bot123' }] }); // Insert success

      await botService.syncBotUserToPostgreSQL(mockBot);

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT _id FROM users WHERE _id = $1',
        ['bot123'],
      );
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['bot123', 'commonly-bot', 'purple']),
      );
    });

    it('should skip sync if user already exists', async () => {
      const mockPool = require('../../../config/db-pg').pool;
      mockPool.query.mockResolvedValueOnce({ rows: [{ _id: 'bot123' }] });

      await botService.syncBotUserToPostgreSQL(mockBot);

      expect(mockPool.query).toHaveBeenCalledTimes(1); // Only check query, no insert
    });

    it('should handle PostgreSQL unavailable gracefully', async () => {
      process.env.PG_HOST = undefined;

      await expect(
        botService.syncBotUserToPostgreSQL(mockBot),
      ).resolves.not.toThrow();
    });
  });

  describe('postIntegrationUpdate', () => {
    beforeEach(() => {
      User.findOne.mockResolvedValue(mockBot);
      Pod.findById.mockResolvedValue(mockPod);
      PGMessage.create.mockResolvedValue({
        id: 'msg123',
        content: 'integration update',
        created_at: new Date(),
      });
      process.env.PG_HOST = 'localhost';
    });

    it('should post integration update successfully', async () => {
      const result = await botService.postIntegrationUpdate(
        'pod123',
        'Slack',
        'New message from Slack channel',
        { channel: '#general' },
      );

      expect(result.success).toBe(true);
      expect(PGMessage.create).toHaveBeenCalledWith(
        'pod123',
        'bot123',
        expect.stringContaining('🔗 Slack Update'),
        'text',
      );
    });
  });

  describe('getBotInfo', () => {
    it('should return bot info for display', async () => {
      User.findOne.mockResolvedValue(mockBot);

      const result = await botService.getBotInfo();

      expect(result).toEqual({
        id: 'bot123',
        username: 'commonly-bot',
        profilePicture: 'purple',
        role: undefined,
        createdAt: mockBot.createdAt,
      });
    });
  });

  describe('botExists', () => {
    it('should return true if bot exists', async () => {
      User.findOne.mockResolvedValue(mockBot);

      const result = await botService.botExists();

      expect(result).toBe(true);
    });

    it('should return false if bot does not exist', async () => {
      User.findOne.mockResolvedValue(null);

      const result = await botService.botExists();

      expect(result).toBe(false);
    });
  });
});
