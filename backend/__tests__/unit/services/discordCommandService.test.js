jest.mock('../../../models/Integration');
jest.mock('../../../models/DiscordSummaryHistory', () => jest.fn());
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/discordService');
jest.mock('../../../services/summarizerService');

const Integration = require('../../../models/Integration');
const DiscordCommandService = require('../../../services/discordCommandService');
const summarizerService = require('../../../services/summarizerService');

describe('DiscordCommandService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('uses integrationId when provided', async () => {
      const integration = {
        _id: 'integration123',
        config: { serverId: 'guild123', channelId: 'channel123' },
      };

      Integration.findOne.mockResolvedValue(integration);

      const service = new DiscordCommandService({
        integrationId: 'integration123',
        guildId: 'guild123',
        channelId: 'channel123',
      });

      const result = await service.initialize();

      expect(result).toBe(true);
      expect(Integration.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: 'integration123',
          type: 'discord',
          isActive: true,
        }),
      );
    });

    it('prefers channel match when channelId is available', async () => {
      const integration = {
        _id: 'integration123',
        config: { serverId: 'guild123', channelId: 'channel123' },
      };

      Integration.findOne.mockResolvedValue(integration);

      const service = new DiscordCommandService({
        guildId: 'guild123',
        channelId: 'channel123',
      });

      const result = await service.initialize();

      expect(result).toBe(true);
      expect(Integration.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'discord',
          isActive: true,
          'config.channelId': 'channel123',
          'config.serverId': 'guild123',
        }),
      );
    });

    it('falls back to guild match when channel lookup fails', async () => {
      const integration = {
        _id: 'integration456',
        config: { serverId: 'guild123', channelId: 'other-channel' },
      };

      Integration.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(integration);

      const service = new DiscordCommandService({
        guildId: 'guild123',
        channelId: 'channel123',
      });

      const result = await service.initialize();

      expect(result).toBe(true);
      expect(Integration.findOne).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'discord',
          isActive: true,
          'config.serverId': 'guild123',
        }),
      );
    });
  });

  it('reports an unavailable AI summary instead of fabricating a Discord recap', async () => {
    const service = new DiscordCommandService({});
    summarizerService.generateSummary.mockRejectedValueOnce(new Error('LLM unavailable'));

    const summary = await service.createDiscordSummary(
      [
        { author: 'lily', content: 'A real discussion happened.' },
        { author: 'kai', content: 'Here is a second real message.' },
        { author: 'juno', content: 'A third message makes this a summary request.' },
      ],
      new Date('2026-09-02T00:00:00Z'),
      new Date('2026-09-02T01:00:00Z'),
    );

    expect(summary.content).toBe('⚠️ AI summary is temporarily unavailable. Please try again shortly.');
  });
});
