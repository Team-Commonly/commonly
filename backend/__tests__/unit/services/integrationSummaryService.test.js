jest.mock('../../../services/summarizerService', () => ({
  generateSummary: jest.fn().mockResolvedValue('AI summary'),
}));

const IntegrationSummaryService = require('../../../services/integrationSummaryService');
const summarizerService = require('../../../services/summarizerService');

describe('IntegrationSummaryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('summarizes small buffers without AI', async () => {
    const integration = {
      type: 'slack',
      config: { channelName: 'general', channelId: 'C123' },
    };
    const buffer = [
      {
        authorName: 'Alice',
        content: 'Hello world',
        timestamp: new Date('2025-01-01T00:00:00Z'),
      },
    ];

    const summary = await IntegrationSummaryService.createSummary(
      integration,
      buffer,
    );

    expect(summary.content).toContain('Alice: Hello world');
    expect(summary.messageCount).toBe(1);
    expect(summary.source).toBe('slack');
    expect(summarizerService.generateSummary).not.toHaveBeenCalled();
  });

  test('uses AI for larger buffers', async () => {
    const integration = {
      type: 'discord',
      config: { serverName: 'Test Server', channelName: 'general' },
    };
    const buffer = [
      { authorName: 'A', content: 'one', timestamp: new Date() },
      { authorName: 'B', content: 'two', timestamp: new Date() },
      { authorName: 'C', content: 'three', timestamp: new Date() },
    ];

    const summary = await IntegrationSummaryService.createSummary(
      integration,
      buffer,
    );

    expect(summary.content).toBe('AI summary');
    expect(summary.summaryType).toBe('discord-hourly');
    expect(summarizerService.generateSummary).toHaveBeenCalledTimes(1);
  });

  test('uses group metadata for channel naming and URL', async () => {
    const integration = {
      type: 'groupme',
      config: {
        groupName: 'Commonly Group',
        groupId: '12345',
        groupUrl: 'https://groupme.com/join/12345',
      },
    };
    const buffer = [
      {
        authorName: 'Sam',
        content: 'Hello',
        timestamp: new Date('2025-01-01T00:00:00Z'),
      },
    ];

    const summary = await IntegrationSummaryService.createSummary(
      integration,
      buffer,
    );

    expect(summary.channelName).toBe('Commonly Group');
    expect(summary.channelUrl).toBe('https://groupme.com/join/12345');
    expect(summary.sourceLabel).toBe('GroupMe');
  });
});
