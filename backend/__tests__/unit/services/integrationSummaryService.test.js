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

  test('names a GroupMe chat by its group name, without its group id or join link', async () => {
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
    // The join link and the group id are the connector creator's: the summary
    // is posted to the pod and kept as a pod asset every member reads.
    expect(summary.channelUrl).toBeNull();
    expect(JSON.stringify(summary)).not.toContain('12345');
    expect(summary.sourceLabel).toBe('GroupMe');
  });

  test('falls back to a generic name, not a routing id, when a chat has no public name', async () => {
    const buffer = [{ authorName: 'Sam', content: 'Hello', timestamp: new Date('2025-01-01T00:00:00Z') }];
    const groupme = await IntegrationSummaryService.createSummary(
      {
        type: 'groupme',
        config: { groupId: '12345', botId: 'b1c2d3', groupUrl: 'https://groupme.com/join/12345/AbCd' },
      },
      buffer,
    );
    const telegram = await IntegrationSummaryService.createSummary(
      { type: 'telegram', config: { chatId: '-1004444' } },
      buffer,
    );
    [groupme, telegram].forEach((summary) => {
      expect(summary.channelName).toBe('channel');
      expect(summary.channelUrl).toBeNull();
      expect(summary.channelId).toBeNull();
    });
    expect(JSON.stringify([groupme, telegram])).not.toMatch(/12345|b1c2d3|-1004444/);
  });
});
