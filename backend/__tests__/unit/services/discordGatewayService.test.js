jest.mock('discord.js', () => ({
  Client: jest.fn(),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
  },
}));

jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

const Integration = require('../../../models/Integration');
const discordGatewayService = require('../../../services/discordGatewayService');

describe('DiscordGatewayService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    discordGatewayService.channelCache = new Map();
    discordGatewayService.cacheExpiresAt = 0;
    discordGatewayService.clientReady = false;
    discordGatewayService.starting = false;
    jest.spyOn(discordGatewayService, 'ensureChannelCache').mockResolvedValue();
  });

  it('buffers messages for enabled integrations', async () => {
    Integration.findByIdAndUpdate.mockResolvedValue({});
    discordGatewayService.channelCache.set('guild-1:channel-1', [
      {
        integrationId: 'integration-1',
        webhookListenerEnabled: true,
        maxBufferSize: 50,
      },
    ]);

    const message = {
      id: 'msg-1',
      content: 'hello',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      author: { id: 'user-1', username: 'Sam', bot: false },
      member: { displayName: 'Sam' },
      attachments: new Map(),
      guild: { id: 'guild-1' },
      channel: { id: 'channel-1' },
    };

    await discordGatewayService.handleMessageCreate(message);

    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      'integration-1',
      expect.objectContaining({
        $push: {
          'config.messageBuffer': expect.objectContaining({
            $slice: -50,
          }),
        },
      }),
    );
  });

  it('skips bot messages', async () => {
    discordGatewayService.channelCache.set('guild-1:channel-1', [
      {
        integrationId: 'integration-1',
        webhookListenerEnabled: true,
      },
    ]);

    const message = {
      id: 'msg-1',
      content: 'hello',
      createdAt: new Date(),
      author: { id: 'bot-1', username: 'bot', bot: true },
      member: { displayName: 'bot' },
      attachments: new Map(),
      guild: { id: 'guild-1' },
      channel: { id: 'channel-1' },
    };

    await discordGatewayService.handleMessageCreate(message);

    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('skips integrations with webhook listener disabled', async () => {
    discordGatewayService.channelCache.set('guild-1:channel-1', [
      {
        integrationId: 'integration-1',
        webhookListenerEnabled: false,
      },
    ]);

    const message = {
      id: 'msg-1',
      content: 'hello',
      createdAt: new Date(),
      author: { id: 'user-1', username: 'Sam', bot: false },
      member: { displayName: 'Sam' },
      attachments: new Map(),
      guild: { id: 'guild-1' },
      channel: { id: 'channel-1' },
    };

    await discordGatewayService.handleMessageCreate(message);

    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('skips messages without guild or channel', async () => {
    const message = {
      id: 'msg-1',
      content: 'hello',
      createdAt: new Date(),
      author: { id: 'user-1', username: 'Sam', bot: false },
      attachments: new Map(),
      guild: null,
      channel: null,
    };

    await discordGatewayService.handleMessageCreate(message);

    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
