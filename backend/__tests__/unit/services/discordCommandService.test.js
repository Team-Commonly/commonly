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
    // Marked as a refusal, not an error: the multi-pod reply reads it.
    expect(result).toMatchObject({ success: false, refused: true });
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


// F161 item 1: /discord-enable and /discord-disable change what a shared
// channel feeds into the pod, so they take the rule the bridge commands use:
// only the installer, matched by the Discord id the bot-add proved.
describe('DiscordCommandService /discord-enable and /discord-disable authority', () => {
  const INSTALLER = '345678901234567890';
  const STRANGER = '456789012345678901';
  const toggle = async (which, actorId, config = { discordUserId: INSTALLER }) => {
    Integration.findOne.mockResolvedValue({ _id: 'integration123', config: { serverId: 'g', channelId: 'c', ...config } });
    Integration.findByIdAndUpdate.mockResolvedValue({});
    const service = new DiscordCommandService({ integrationId: 'integration123' });
    await service.initialize();
    return which === 'enable' ? service.handleEnableCommand(actorId) : service.handleDisableCommand(actorId);
  };

  beforeEach(() => jest.clearAllMocks());

  it.each([['enable', true], ['disable', false]])('the installer may %s sync', async (which, flag) => {
    const result = await toggle(which, INSTALLER);
    expect(result.success).toBe(true);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('integration123', { 'config.webhookListenerEnabled': flag });
  });

  it.each(['enable', 'disable'])('someone else in the channel is refused /discord-%s', async (which) => {
    const result = await toggle(which, STRANGER);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/only the person who connected this channel/i);
    // No ping: the legacy reply carries no allowed_mentions guard.
    expect(result.content).not.toContain('<@');
  });

  it('a caller with no Discord id is refused', async () => {
    const result = await toggle('enable', undefined);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('a row with no proven installer admits no one, and says how to fix it', async () => {
    const result = await toggle('disable', INSTALLER, {});
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/add the bot again/i);
  });
});
