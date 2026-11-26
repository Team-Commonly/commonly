// F627: a failed Discord call is logged as its message and status, never its
// request (the AxiosError config carries `Authorization: Bot <token>`).
jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue('logged_in'),
    on: jest.fn(),
  })),
  GatewayIntentBits: { Guilds: 'Guilds', GuildMessages: 'GuildMessages', GuildWebhooks: 'GuildWebhooks' },
}));
jest.mock('../../../models/Integration');
jest.mock('../../../models/DiscordIntegration', () => ({ findByIdAndUpdate: jest.fn() }));
jest.mock('../../../models/DiscordSummaryHistory', () => jest.fn());
jest.mock('../../../services/connectorSecrets', () => ({
  get: jest.fn(), put: jest.fn(), revoke: jest.fn(), listWithUnavailableKey: jest.fn(),
}));
jest.mock('../../../services/discordCommandService');
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../config/discord', () => ({
  botToken: 'test-bot-token',
  baseUrl: 'https://discord.test/api',
  messageRateLimit: { timeWindow: 60_000, maxMessages: 10 },
  errors: { RATE_LIMITED: 'Rate limited' },
}));
jest.mock('axios');

const axios = require('axios');
const DiscordService = require('../../../services/discordService');
const { fakeAxiosError, printed, expectNoSecrets } = require('../../utils/fakeAxiosError');

describe('discordService failure logging (F627)', () => {
  let service;
  let errSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    service = new DiscordService('integration123');
    service.integration = {
      _id: 'integration123',
      config: { serverId: 'guild123', channelId: 'channel123' },
      platformIntegration: { serverId: 'guild123', channelId: 'channel123' },
    };
    service.initialize = jest.fn().mockResolvedValue(true);
  });

  afterEach(() => errSpy.mockRestore());

  it('getChannels logs the label and message, not the request', async () => {
    axios.get = jest.fn().mockRejectedValue(fakeAxiosError('Discord said no'));
    await expect(service.getChannels()).rejects.toThrow('Discord said no');
    const text = printed(errSpy);
    expect(text).toContain('Error fetching Discord channels:');
    expect(text).toContain('Discord said no');
    expect(text).toContain('401');
    expectNoSecrets(text);
  });

  it('testConnection logs the label and message, not the request, and still returns false', async () => {
    axios.get = jest.fn().mockRejectedValue(fakeAxiosError('Discord said no'));
    await expect(service.testConnection()).resolves.toBe(false);
    const text = printed(errSpy);
    expect(text).toContain('Error testing Discord connection:');
    expect(text).toContain('Discord said no');
    expectNoSecrets(text);
  });
});
