// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const DiscordService = require('./discordService');
// eslint-disable-next-line global-require
const summarizerService = require('./summarizerService');

interface CommandServiceOptions {
  guildId?: string;
  channelId?: string;
  integrationId?: unknown;
}

interface CommandResult {
  success: boolean;
  content: string;
}

interface SyncResult {
  success: boolean;
  content: string;
  messageCount?: number;
}

interface DiscordMessage {
  author?: string;
  content?: string;
  [key: string]: unknown;
}

interface SummaryLike {
  title?: string;
  content?: string;
  type?: string;
  summaryType?: string;
  messageCount?: number;
  timeRange?: { start?: unknown; end?: unknown };
  metadata?: { totalItems?: number };
}

interface IntegrationDoc {
  _id?: unknown;
  podId?: { name?: string; type?: string } | null;
  status?: string;
  lastSync?: unknown;
  config?: {
    serverName?: string;
    channelName?: string;
    serverId?: string;
    channelId?: string;
    webhookListenerEnabled?: boolean;
  };
  populate(field: string, select: string): Promise<void>;
}

interface DiscordSummaryData {
  content: string;
  messageCount: number;
  timeRange: { start: Date; end: Date };
  serverName: string;
  channelName: string;
  serverId: string | null;
  channelId: string | null;
  summaryType: string;
}

class DiscordCommandService {
  private guildId: string | null;

  private channelId: string | null;

  private integrationId: unknown;

  private integration: IntegrationDoc | null;

  constructor(options: CommandServiceOptions | string = {}) {
    if (typeof options === 'string') {
      this.guildId = options;
      this.channelId = null;
      this.integrationId = null;
    } else {
      const { guildId, channelId, integrationId } = options;
      this.guildId = guildId || null;
      this.channelId = channelId || null;
      this.integrationId = integrationId || null;
    }
    this.integration = null;
  }

  async initialize(): Promise<boolean> {
    try {
      if (this.integrationId) {
        this.integration = await Integration.findOne({
          _id: this.integrationId,
          type: 'discord',
          isActive: true,
        }) as IntegrationDoc | null;
      }

      if (!this.integration && this.channelId) {
        const channelQuery: Record<string, unknown> = {
          type: 'discord',
          isActive: true,
          'config.channelId': this.channelId,
        };
        if (this.guildId) {
          channelQuery['config.serverId'] = this.guildId;
        }
        this.integration = await Integration.findOne(channelQuery) as IntegrationDoc | null;
      }

      if (!this.integration && this.guildId) {
        this.integration = await Integration.findOne({
          type: 'discord',
          isActive: true,
          'config.serverId': this.guildId,
        }) as IntegrationDoc | null;
      }

      if (!this.integration) {
        throw new Error(
          `Integration not found for ${this.channelId ? 'channel' : 'guild'} ${
            this.channelId || this.guildId || 'unknown'
          }`,
        );
      }
      return true;
    } catch (error) {
      console.error('Error initializing Discord command service:', error);
      return false;
    }
  }

  async handleSummaryCommand(): Promise<CommandResult> {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: '❌ Discord integration not found. Please install the bot first.',
        };
      }

      const latestSummary = await Summary.findOne({
        type: 'chats',
        podId: this.integration.podId,
      }).sort({ createdAt: -1 }) as SummaryLike | null;

      if (!latestSummary) {
        return {
          success: true,
          content: '📝 No recent summaries available for this chat pod.',
        };
      }

      const formattedSummary = this.formatSummaryForDiscord(latestSummary);

      return {
        success: true,
        content: formattedSummary,
      };
    } catch (error) {
      console.error('Error handling summary command:', error);
      return {
        success: false,
        content: '❌ An error occurred while fetching the summary.',
      };
    }
  }

  async handleSummaryCommandWithDefer(interactionToken: string): Promise<CommandResult> {
    try {
      const discordService = new DiscordService(this.integration!._id);
      await discordService.deferResponse(interactionToken, false);

      const result = await this.handleSummaryCommand();

      await discordService.sendFollowupMessage(interactionToken, result.content);

      return result;
    } catch (error) {
      console.error('Error handling summary command with defer:', error);

      const discordService = new DiscordService(this.integration!._id);
      await discordService.sendFollowupMessage(
        interactionToken,
        '❌ An error occurred while fetching the summary.',
        { ephemeral: true },
      );

      return {
        success: false,
        content: '❌ An error occurred while fetching the summary.',
      };
    }
  }

  async handleStatusCommand(): Promise<CommandResult> {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return { success: false, content: '❌ Discord integration not found.' };
      }

      await this.integration.populate('podId', 'name type');

      const { status } = this.integration;
      const podName = (this.integration.podId as { name?: string } | null)?.name || 'Unknown Pod';
      const podType = (this.integration.podId as { type?: string } | null)?.type || 'unknown';
      const serverName = this.integration.config?.serverName || 'Unknown Server';
      const channelName = this.integration.config?.channelName || 'Unknown Channel';
      const syncEnabled = this.integration.config?.webhookListenerEnabled ? '✅ Enabled' : '❌ Disabled';

      const statusMessage = `🤖 **Discord Integration Status**

📊 **Status:** ${this.getStatusEmoji(status)} ${status}
🎯 **Commonly Pod:** ${podName} (${podType})
🏠 **Server:** ${serverName}
📺 **Channel:** ${channelName}
🔗 **Auto Sync:** ${syncEnabled}
⏰ **Last Sync:** ${this.integration.lastSync ? new Date(this.integration.lastSync as string).toLocaleString() : 'Never'}`;

      return { success: true, content: statusMessage };
    } catch (error) {
      console.error('Error handling status command:', error);
      return { success: false, content: '❌ An error occurred while fetching the status.' };
    }
  }

  async handleEnableCommand(): Promise<CommandResult> {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return { success: false, content: '❌ Discord integration not found.' };
      }

      await Integration.findByIdAndUpdate(this.integration._id, {
        'config.webhookListenerEnabled': true,
      });

      return {
        success: true,
        content: '✅ Auto sync enabled! Discord channel activity will now be fetched and summarized hourly, then queued for Commonly Bot.',
      };
    } catch (error) {
      console.error('Error handling enable command:', error);
      return { success: false, content: '❌ An error occurred while enabling the webhook listener.' };
    }
  }

  async handleDisableCommand(): Promise<CommandResult> {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return { success: false, content: '❌ Discord integration not found.' };
      }

      await Integration.findByIdAndUpdate(this.integration._id, {
        'config.webhookListenerEnabled': false,
      });

      return {
        success: true,
        content: '🔕 Auto sync disabled. Discord channel activity will no longer be fetched or posted to your Commonly pod.',
      };
    } catch (error) {
      console.error('Error handling disable command:', error);
      return { success: false, content: '❌ An error occurred while disabling the webhook listener.' };
    }
  }

  async handlePushCommand(discordServiceInstance: unknown = null): Promise<CommandResult> {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return { success: false, content: '❌ Discord integration not found.' };
      }

      if (!this.integration.config?.webhookListenerEnabled) {
        return {
          success: false,
          content: '⚠️ Auto sync is disabled. Use `/discord-enable` first to enable Discord activity sync.',
        };
      }

      const syncResult = await (discordServiceInstance as { syncRecentMessages: (n: number, opts: unknown) => Promise<SyncResult> }).syncRecentMessages(1, {
        summaryType: 'manual',
      });

      if (syncResult.success && (syncResult.messageCount || 0) > 0) {
        return {
          success: true,
          content: `✅ ${syncResult.content} Check your pod for updates from Commonly Bot.`,
        };
      }
      if (syncResult.success && !syncResult.messageCount) {
        return { success: true, content: `📭 ${syncResult.content}` };
      }
      return { success: false, content: `❌ ${syncResult.content}` };
    } catch (error) {
      console.error('Error handling push command:', error);
      return { success: false, content: '❌ An error occurred while pushing Discord activity.' };
    }
  }

  async createDiscordSummary(
    messages: DiscordMessage[],
    startTime: Date,
    endTime: Date,
  ): Promise<DiscordSummaryData> {
    const userMessages = messages.filter((msg) => msg.author && msg.content);
    const uniqueUsers = [...new Set(userMessages.map((msg) => msg.author as string))];

    let content: string;
    if (userMessages.length === 0) {
      content = 'Recent Discord activity consisted mainly of bot messages and system notifications.';
    } else if (userMessages.length <= 2) {
      content = userMessages.map((msg) => `${msg.author}: ${msg.content}`).join('\n');
    } else {
      try {
        const messageContent = userMessages
          .map((msg) => `${msg.author}: ${msg.content}`)
          .join('\n');

        content = await summarizerService.generateSummary(messageContent, 'discord') as string;
      } catch (error) {
        console.error('Failed to generate AI summary for Discord messages:', error);
        const topUsers = uniqueUsers.slice(0, 3);
        content = `Active discussion with ${uniqueUsers.length} participants (${topUsers.join(', ')}${uniqueUsers.length > 3 ? ' and others' : ''}).`;
      }
    }

    return {
      content,
      messageCount: messages.length,
      timeRange: { start: startTime, end: endTime },
      serverName: this.integration?.config?.serverName || 'Discord Server',
      channelName: this.integration?.config?.channelName || 'general',
      serverId: this.integration?.config?.serverId || null,
      channelId: this.integration?.config?.channelId || null,
      summaryType: 'manual',
    };
  }

  extractTopics(messages: DiscordMessage[]): string[] {
    const text = messages.map((msg) => msg.content).join(' ').toLowerCase();
    const commonWords = new Set([
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does',
      'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall',
      'a', 'an', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
      'we', 'they', 'me', 'him', 'her', 'us', 'them',
    ]);

    const words = text.match(/\b\w+\b/g) || [];
    const wordCount: Record<string, number> = {};

    words.forEach((word) => {
      if (word.length > 3 && !commonWords.has(word)) {
        wordCount[word] = (wordCount[word] || 0) + 1;
      }
    });

    return Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([word]) => word);
  }

  formatSummaryForDiscord(summary: SummaryLike): string {
    const formatDiscordTimestamp = (value: unknown): string | null => {
      if (!value) return null;
      const date = new Date(value as string);
      if (Number.isNaN(date.getTime())) return null;
      return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
    };

    const startTag = formatDiscordTimestamp(summary.timeRange?.start);
    const endTag = formatDiscordTimestamp(summary.timeRange?.end);
    const timeRange = startTag && endTag ? `${startTag} – ${endTag}` : 'Recent activity';

    const messageCount = summary.messageCount || summary.metadata?.totalItems || 'Unknown';
    const summaryType = summary.summaryType || summary.type || 'chat';
    const title = summary.title || 'Chat Summary';

    return `📊 **${title}**

⏰ **Time Period:** ${timeRange}
💬 **Messages Analyzed:** ${messageCount}
📝 **Summary Type:** ${summaryType}

${summary.content}

---
*Generated by Commonly AI*`;
  }

  getStatusEmoji(status?: string): string {
    switch (status) {
      case 'connected': return '🟢';
      case 'disconnected': return '🔴';
      case 'error': return '🟡';
      case 'pending': return '🟠';
      default: return '⚪';
    }
  }
}

export = DiscordCommandService;
