jest.mock('../../../services/discordCommandService');
jest.mock('../../../services/discordService');

const DiscordCommandService = require('../../../services/discordCommandService');
const DiscordService = require('../../../services/discordService');
const {
  runCommandForIntegration,
  runDiscordCommandForIntegrations,
} = require('../../../services/discordMultiCommandService');

describe('discordMultiCommandService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs summary command for a single integration', async () => {
    const integration = { _id: 'integration123' };

    const mockCommandService = {
      initialize: jest.fn().mockResolvedValue(true),
      handleSummaryCommand: jest.fn().mockResolvedValue({
        success: true,
        content: 'Summary content',
      }),
    };

    DiscordCommandService.mockImplementation(() => mockCommandService);

    const result = await runCommandForIntegration({
      commandName: 'commonly-summary',
      integration,
      guildId: 'guild123',
      channelId: 'channel123',
    });

    expect(mockCommandService.initialize).toHaveBeenCalled();
    expect(mockCommandService.handleSummaryCommand).toHaveBeenCalled();
    expect(result.integration).toBe(integration);
    expect(result.result.content).toBe('Summary content');
  });

  it('runs push command with a Discord service instance', async () => {
    const integration = { _id: 'integration123' };

    const mockCommandService = {
      handlePushCommand: jest.fn().mockResolvedValue({
        success: true,
        content: 'Push content',
      }),
    };

    const mockDiscordService = {
      initialize: jest.fn().mockResolvedValue(true),
      commandService: mockCommandService,
    };

    DiscordService.mockImplementation(() => mockDiscordService);

    const result = await runCommandForIntegration({
      commandName: 'discord-push',
      integration,
      guildId: 'guild123',
      channelId: 'channel123',
    });

    expect(DiscordService).toHaveBeenCalledWith('integration123');
    const serviceInstance = DiscordService.mock.results[0].value;
    expect(serviceInstance.initialize).toHaveBeenCalled();
    expect(serviceInstance.commandService).toBe(mockCommandService);
    expect(mockCommandService.handlePushCommand).toHaveBeenCalledWith(
      serviceInstance,
    );
    expect(result.result.content).toBe('Push content');
  });

  it('runs commands for multiple integrations', async () => {
    const integrationA = { _id: 'integrationA' };
    const integrationB = { _id: 'integrationB' };

    DiscordCommandService
      .mockImplementationOnce(() => ({
        initialize: jest.fn().mockResolvedValue(true),
        handleStatusCommand: jest.fn().mockResolvedValue({
          success: true,
          content: 'Status A',
        }),
      }))
      .mockImplementationOnce(() => ({
        initialize: jest.fn().mockResolvedValue(true),
        handleStatusCommand: jest.fn().mockResolvedValue({
          success: true,
          content: 'Status B',
        }),
      }));

    const results = await runDiscordCommandForIntegrations({
      commandName: 'discord-status',
      integrations: [integrationA, integrationB],
      guildId: 'guild123',
      channelId: 'channel123',
    });

    expect(results).toHaveLength(2);
    expect(results[0].integration).toBe(integrationA);
    expect(results[0].result.content).toBe('Status A');
    expect(results[1].integration).toBe(integrationB);
    expect(results[1].result.content).toBe('Status B');
  });
});
