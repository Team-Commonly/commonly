// eslint-disable-next-line global-require
const summarizerService = require('./summarizerService');
// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');

const SOURCE_LABELS: Record<string, string> = {
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  groupme: 'GroupMe',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  x: 'X',
  instagram: 'Instagram',
};

interface NormalizedMessage {
  authorName?: string;
  content?: string;
  timestamp?: string | Date;
}

interface IntegrationConfig {
  serverName?: string;
  channelName?: string;
  groupName?: string;
  chatTitle?: string;
  username?: string;
  igUserId?: string;
  channelId?: string;
  groupId?: string;
  chatId?: string;
  channelUrl?: string;
  groupUrl?: string;
  serverId?: string;
}

interface Integration {
  type: string;
  config?: IntegrationConfig;
}

interface SummaryResult {
  content: string;
  messageCount: number;
  timeRange: { start: Date; end: Date };
  source: string;
  sourceLabel: string;
  serverName: string | null;
  channelName: string;
  channelUrl: string | null;
  serverId: string | null;
  channelId: string | null;
  summaryType: string;
}

class IntegrationSummaryService {
  static buildSummaryContent(messages: NormalizedMessage[]): string | Promise<string> {
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

    return summarizerService.generateSummary(messageContent, 'integration') as Promise<string>;
  }

  static async createSummary(integration: Integration, bufferMessages: unknown[]): Promise<SummaryResult> {
    const messages: NormalizedMessage[] = (bufferMessages || [])
      .map((msg) => normalizeBufferMessage(msg) as NormalizedMessage)
      .filter(Boolean);

    const timestamps = messages
      .map((msg) => new Date(msg.timestamp as string | Date).getTime())
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
      content: content as string,
      messageCount: messages.length,
      timeRange,
      source: integration.type,
      sourceLabel: SOURCE_LABELS[integration.type] || 'External',
      serverName: integration.config?.serverName || null,
      channelName:
        integration.config?.channelName
        || integration.config?.groupName
        || integration.config?.chatTitle
        || integration.config?.username
        || integration.config?.igUserId
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

export default IntegrationSummaryService;
