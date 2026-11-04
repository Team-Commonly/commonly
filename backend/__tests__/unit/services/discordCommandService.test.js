jest.mock('../../../models/Integration');
jest.mock('../../../models/DiscordSummaryHistory', () => jest.fn());
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/discordService');
jest.mock('../../../services/summarizerService');
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

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

// F143: /commonly-summary posts the pod's latest summary into the guild channel
// for everyone in it — the Discord twin of Telegram /tldr and GroupMe !pod.
// Rows plain members bound before #3436 get a refusal and no summary.
describe('DiscordCommandService /commonly-summary on a shared channel', () => {
  const Pod = require('../../../models/Pod');
  const User = require('../../../models/User');
  const Summary = require('../../../models/Summary');
  const row = (createdBy) => ({
    _id: 'integration123', podId: 'pod-1', createdBy, config: { serverId: 'g', channelId: 'c' },
  });
  const summarize = async (createdBy) => {
    Integration.findOne.mockResolvedValue(row(createdBy));
    const service = new DiscordCommandService({ integrationId: 'integration123' });
    await service.initialize();
    return service.handleSummaryCommand();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'creator-1', members: ['creator-1', 'member-1'] }),
    });
    User.findById.mockImplementation(async (id) => ({ _id: String(id), role: String(id) === 'admin-1' ? 'admin' : 'user' }));
    Summary.findOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({ title: 'T', content: 'pod secrets', type: 'chats' }),
    });
  });

  it('withholds the summary from a channel a plain member bound', async () => {
    const result = await summarize('member-1');
    expect(Summary.findOne).not.toHaveBeenCalled();
    expect(result.content).not.toContain('pod secrets');
    expect(result.content).toMatch(/only the pod's creator/i);
  });

  it.each([['the pod creator', 'creator-1'], ['an instance admin', 'admin-1']])(
    'posts the summary to a channel %s bound',
    async (_label, createdBy) => {
      const result = await summarize(createdBy);
      expect(result.success).toBe(true);
      expect(result.content).toContain('pod secrets');
    },
  );
});

