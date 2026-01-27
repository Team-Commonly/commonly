const summarizerService = require('./summarizerService');
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');

const SOURCE_LABELS = {
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  groupme: 'GroupMe',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
};

class IntegrationSummaryService {
  static buildSummaryContent(messages) {
    const userMessages = messages.filter((msg) => msg.authorName && msg.content);

    if (userMessages.length === 0) {
      return 'Recent activity consisted mainly of system updates or empty messages.';
    }

    if (userMessages.length <= 2) {
      return userMessages
        .map((msg) => `${msg.authorName}: ${msg.content}`)
        .join('\n');
    }

    const messageContent = userMessages
      .map((msg) => `${msg.authorName}: ${msg.content}`)
      .join('\n');

    return summarizerService.generateSummary(messageContent, 'integration');
  }

  static async createSummary(integration, bufferMessages) {
    const messages = (bufferMessages || [])
      .map((msg) => normalizeBufferMessage(msg))
      .filter(Boolean);

    const timestamps = messages
      .map((msg) => new Date(msg.timestamp).getTime())
      .filter((value) => !Number.isNaN(value))
      .sort((a, b) => a - b);

    const timeRange = {
      start: timestamps.length ? new Date(timestamps[0]) : new Date(),
      end: timestamps.length ? new Date(timestamps[timestamps.length - 1]) : new Date(),
    };

    const content = await IntegrationSummaryService.buildSummaryContent(messages);

    const summaryType = integration.type === 'discord'
      ? 'discord-hourly'
      : `${integration.type}-hourly`;

    return {
      content,
      messageCount: messages.length,
      timeRange,
      source: integration.type,
      sourceLabel: SOURCE_LABELS[integration.type] || 'External',
      serverName: integration.config?.serverName || null,
      channelName:
        integration.config?.channelName
        || integration.config?.groupName
        || integration.config?.chatTitle
        || integration.config?.channelId
        || integration.config?.groupId
        || integration.config?.chatId
        || 'channel',
      channelUrl: integration.config?.channelUrl
        || integration.config?.groupUrl
        || null,
      serverId: integration.config?.serverId || null,
      channelId: integration.config?.channelId || integration.config?.chatId || null,
      summaryType,
    };
  }
}

module.exports = IntegrationSummaryService;
