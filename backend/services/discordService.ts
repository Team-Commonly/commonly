// eslint-disable-next-line global-require
const axios = require('axios');
// eslint-disable-next-line global-require
const { Client, GatewayIntentBits } = require('discord.js');
// eslint-disable-next-line global-require
const DiscordIntegration = require('../models/DiscordIntegration');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const DiscordCommandService = require('./discordCommandService');
// eslint-disable-next-line global-require
const summarizerService = require('./summarizerService');
// eslint-disable-next-line global-require
const config = require('../config/discord');

interface FetchMessagesOptions {
  channelId?: string;
  botToken?: string;
  limit?: number;
  before?: string;
  after?: string;
}

interface FetchedMessage {
  id: string;
  authorId: string | undefined;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: string[];
  reactions: string[];
  isBot: boolean;
}

interface DiscordConfig {
  serverId: string;
  channelId: string;
  webhookUrl: string;
  botToken: string;
  [key: string]: unknown;
}

interface IntegrationDoc {
  _id: unknown;
  podId: unknown;
  status?: string;
  config?: {
    channelId?: string;
    botToken?: string;
    serverId?: string;
    webhookListenerEnabled?: boolean;
    messageBuffer?: BufferedMessage[];
    lastSummaryAt?: Date;
    commandsRegistered?: boolean;
    lastCommandRegistration?: Date;
    registeredGuildId?: string;
    lastRegistrationError?: string;
    lastRegistrationAttempt?: Date;
  };
  platformIntegration?: {
    _id: unknown;
    serverId?: string;
    channelId?: string;
    webhookUrl?: string;
    webhookId?: string;
  };
  [key: string]: unknown;
}

interface BufferedMessage {
  authorName?: string;
  content?: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

interface SyncOptions {
  summaryType?: string;
}

interface SyncResult {
  success: boolean;
  messageCount: number;
  content: string;
}

interface CommandResult {
  success: boolean;
  content: string;
}

interface InteractionData {
  type: number;
  data?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface InteractionResponse {
  type: number;
  data: {
    content: string;
    flags: number;
    [key: string]: unknown;
  };
}

interface FollowupOptions {
  ephemeral?: boolean;
  embeds?: unknown[];
  components?: unknown[];
}

interface VerifyCommandResult {
  success: boolean;
  registeredCommands?: string[];
  missingCommands?: string[];
  totalExpected?: number;
  totalFound?: number;
  error?: string;
}

interface BulkRegistrationResult {
  success: boolean;
  registered?: number;
  failed?: number;
  total?: number;
  results?: Array<{
    integrationId: unknown;
    guildId?: string;
    success: boolean;
    error?: string;
  }>;
  error?: string;
}

/**
 * Discord Integration Service
 * Handles Discord bot integration and webhook management
 */
class DiscordService {
  integrationId: unknown;
  client: unknown;
  clientReady: boolean;
  commandService: unknown;
  integration: IntegrationDoc | null;

  static async fetchMessages(options: FetchMessagesOptions = {}): Promise<FetchedMessage[]> {
    const {
      channelId, botToken, limit = 50, before, after,
    } = options;

    if (!channelId) {
      throw new Error('Channel ID is required');
    }
    if (!botToken) {
      throw new Error('Discord bot token is required');
    }

    const params: Record<string, unknown> = {
      limit: Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 100),
    };
    if (before) params.before = before;
    if (after) params.after = after;

    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      params,
    });

    return ((response.data || []) as Record<string, unknown>[]).map((msg) => ({
      id: msg.id as string,
      authorId: (msg.author as Record<string, unknown> | undefined)?.id as string | undefined,
      authorName: ((msg.author as Record<string, unknown> | undefined)?.username as string) || 'Unknown',
      content: (msg.content as string) || '',
      timestamp: msg.timestamp as string,
      attachments: ((msg.attachments || []) as Record<string, unknown>[]).map((att) => att.url as string).filter(Boolean),
      reactions: ((msg.reactions || []) as Record<string, unknown>[]).map((reaction) => (reaction.emoji as Record<string, unknown> | undefined)?.name as string).filter(Boolean),
      isBot: Boolean((msg.author as Record<string, unknown> | undefined)?.bot),
    }));
  }

  constructor(integrationId: unknown) {
    this.integrationId = integrationId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildWebhooks,
      ],
    });

    this.clientReady = false;
    (this.client as { on: (event: string, cb: (err: unknown) => void) => void }).on('error', (error) => {
      console.error('Discord client error:', error);
    });
    (this.client as { on: (event: string, cb: (err: unknown) => void) => void }).on('shardError', (error) => {
      console.error('Discord shard error:', error);
    });

    this.commandService = null;
    this.integration = null;
  }

  async ensureClientReady(): Promise<boolean> {
    if (this.clientReady) {
      return true;
    }

    if (!config.botToken) {
      throw new Error('Discord bot token not configured');
    }

    try {
      await (this.client as { login: (token: string) => Promise<void> }).login(config.botToken);
      this.clientReady = true;
      return true;
    } catch (error) {
      console.error('Error logging in Discord client:', error);
      throw error;
    }
  }

  async initialize(): Promise<boolean> {
    try {
      const integration = await Integration.findById(
        this.integrationId,
      ).populate('platformIntegration') as IntegrationDoc | null;

      if (!integration) {
        throw new Error('Integration not found');
      }

      this.integration = integration;

      const guildId =
        integration.platformIntegration?.serverId ||
        integration.config?.serverId;
      const channelId =
        integration.platformIntegration?.channelId ||
        integration.config?.channelId;
      if (!guildId) {
        throw new Error('Guild ID not found in integration');
      }

      this.commandService = new DiscordCommandService({
        guildId,
        channelId,
        integrationId: this.integrationId,
      });
      await (this.commandService as { initialize: () => Promise<void> }).initialize();

      return true;
    } catch (error) {
      console.error('Error initializing Discord service:', error);
      return false;
    }
  }

  async createWebhook(channelId: string): Promise<unknown> {
    try {
      await this.ensureClientReady();
      const clientWithChannels = this.client as {
        channels: { fetch: (id: string) => Promise<unknown> };
        user: unknown;
      };
      const channel = await clientWithChannels.channels.fetch(channelId) as {
        permissionsFor: (user: unknown) => { has: (perms: unknown) => boolean };
        createWebhook: (name: string, opts: unknown) => Promise<unknown>;
      } | null;
      if (!channel) {
        throw new Error(config.errors.CHANNEL_NOT_FOUND);
      }

      const permissions = channel.permissionsFor(clientWithChannels.user);
      if (!permissions.has(config.requiredPermissions)) {
        throw new Error(config.errors.MISSING_PERMISSIONS);
      }

      const webhook = await channel.createWebhook(config.webhookName, {
        avatar: config.webhookAvatar,
      });

      return webhook;
    } catch (error) {
      console.error('Error creating webhook:', error);
      throw error;
    }
  }

  async connect(): Promise<boolean> {
    try {
      await this.ensureClientReady();
      const clientWithGuilds = this.client as {
        guilds: { fetch: (id: string) => Promise<unknown> };
      };
      const guild = await clientWithGuilds.guilds.fetch(
        (this.integration as IntegrationDoc).platformIntegration?.serverId as string,
      ) as {
        channels: { fetch: (id: string) => Promise<unknown> };
      } | null;
      if (!guild) {
        throw new Error(config.errors.SERVER_NOT_FOUND);
      }

      const channel = await guild.channels.fetch(
        (this.integration as IntegrationDoc).platformIntegration?.channelId as string,
      ) as { id: string } | null;
      if (!channel) {
        throw new Error(config.errors.CHANNEL_NOT_FOUND);
      }

      if (!(this.integration as IntegrationDoc).platformIntegration?.webhookUrl) {
        const webhook = await this.createWebhook(channel.id) as { url: string; id: string };

        await DiscordIntegration.findByIdAndUpdate(
          (this.integration as IntegrationDoc).platformIntegration?._id,
          {
            webhookUrl: webhook.url,
            webhookId: webhook.id,
          },
        );
      }

      await Integration.findByIdAndUpdate(this.integrationId, {
        status: 'connected',
        lastSync: new Date(),
      });

      return true;
    } catch (error) {
      const err = error as { message?: string };
      console.error('Error connecting to Discord:', error);

      await Integration.findByIdAndUpdate(this.integrationId, {
        status: 'error',
        lastError: err.message,
      });

      return false;
    }
  }

  async disconnect(): Promise<boolean> {
    try {
      await this.ensureClientReady();
      if ((this.integration as IntegrationDoc).platformIntegration?.webhookId) {
        try {
          const clientWithChannels = this.client as {
            channels: { fetch: (id: string) => Promise<unknown> };
          };
          const channel = await clientWithChannels.channels.fetch(
            (this.integration as IntegrationDoc).platformIntegration?.channelId as string,
          ) as { fetchWebhooks: () => Promise<Map<string, { delete: () => Promise<void> }>> };
          const webhooks = await channel.fetchWebhooks();
          const webhook = webhooks.get(
            (this.integration as IntegrationDoc).platformIntegration?.webhookId as string,
          );
          if (webhook) {
            await webhook.delete();
          }
        } catch (error) {
          console.warn('Error removing webhook:', error);
        }
      }

      await Integration.findByIdAndUpdate(this.integrationId, {
        status: 'disconnected',
        lastSync: new Date(),
      });

      return true;
    } catch (error) {
      console.error('Error disconnecting from Discord:', error);
      return false;
    }
  }

  async sendMessage(message: string): Promise<boolean> {
    try {
      if (!(this.integration as IntegrationDoc).platformIntegration?.webhookUrl) {
        throw new Error('Webhook URL not found');
      }

      const now = Date.now();
      const recentMessages = await Integration.find({
        _id: this.integrationId,
        'messageHistory.timestamp': {
          $gt: now - config.messageRateLimit.timeWindow,
        },
      }).count();

      if (recentMessages >= config.messageRateLimit.maxMessages) {
        throw new Error(config.errors.RATE_LIMITED);
      }

      const response = await fetch(
        (this.integration as IntegrationDoc).platformIntegration?.webhookUrl as string,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message,
            username: config.webhookName,
            avatar_url: config.webhookAvatar,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await Integration.findByIdAndUpdate(this.integrationId, {
        $push: {
          messageHistory: {
            timestamp: now,
            type: 'outgoing',
            content: message,
          },
        },
      });

      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  async getStats(): Promise<unknown> {
    try {
      const stats = await Integration.aggregate([
        { $match: { _id: this.integrationId } },
        {
          $project: {
            messageCount: { $size: '$messageHistory' },
            lastSync: 1,
            status: 1,
            uptime: {
              $subtract: [new Date(), '$createdAt'],
            },
          },
        },
      ]);

      return (stats as unknown[])[0];
    } catch (error) {
      console.error('Error getting stats:', error);
      return null;
    }
  }

  async fetchMessages(options: FetchMessagesOptions = {}): Promise<FetchedMessage[]> {
    try {
      return DiscordService.fetchMessages({
        channelId: (this.integration as IntegrationDoc | null)?.config?.channelId,
        botToken: (this.integration as IntegrationDoc | null)?.config?.botToken || process.env.DISCORD_BOT_TOKEN,
        ...options,
      });
    } catch (error) {
      console.error('Error fetching Discord messages:', error);
      throw error;
    }
  }

  async getChannels(): Promise<unknown[]> {
    try {
      const discordIntegration = this.integration as IntegrationDoc;
      const url = `${(config as Record<string, unknown>).baseUrl}/guilds/${discordIntegration.platformIntegration?.serverId}/channels`;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${discordIntegration.platformIntegration?.['botToken']}`,
          'Content-Type': 'application/json',
        },
      });

      return ((response.data as Record<string, unknown>[])
        .filter((channel) => channel.type === 0)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          topic: channel.topic,
          position: channel.position,
        })));
    } catch (error) {
      console.error('Error fetching Discord channels:', error);
      throw error;
    }
  }

  async getStatus(): Promise<string> {
    try {
      await this.initialize();
      return (this.integration as IntegrationDoc).status || 'unknown';
    } catch (error) {
      return 'error';
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const discordIntegration = this.integration as IntegrationDoc;
      const botResponse = await axios.get(`${(config as Record<string, unknown>).baseUrl}/users/@me`, {
        headers: {
          Authorization: `Bot ${discordIntegration.platformIntegration?.['botToken']}`,
          'Content-Type': 'application/json',
        },
      });

      return botResponse.status === 200;
    } catch (error) {
      console.error('Error testing Discord connection:', error);
      return false;
    }
  }

  static async validateConfig(discordConfig: DiscordConfig): Promise<boolean> {
    const requiredFields = ['serverId', 'channelId', 'webhookUrl', 'botToken'];

    const missingFields = requiredFields.filter(
      (field) => !discordConfig[field],
    );
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    if (!discordConfig.webhookUrl.includes('discord.com/api/webhooks/')) {
      throw new Error('Invalid Discord webhook URL format');
    }

    return true;
  }

  async handleWebhook(event: Record<string, unknown>): Promise<unknown> {
    try {
      switch (event.type) {
        case 1:
          return { type: 1 };

        case 0:
          await this.handleMessageCreate(event.d as Record<string, unknown>);
          break;

        case 3:
          await this.handleMessageUpdate(event.d as Record<string, unknown>);
          break;

        case 4:
          await this.handleMessageDelete(event.d as Record<string, unknown>);
          break;

        default:
          console.log('Unhandled Discord event type:', event.type);
      }
    } catch (error) {
      console.error('Error handling Discord webhook:', error);
      throw error;
    }
  }

  async handleMessageCreate(messageData: Record<string, unknown>): Promise<void> {
    try {
      const discordIntegration = this.integration as IntegrationDoc;
      if (messageData.channel_id !== discordIntegration.platformIntegration?.channelId) {
        return;
      }

      const message = {
        messageId: messageData.id as string,
        content: messageData.content as string,
        author: (messageData.author as Record<string, unknown>)?.username as string,
        timestamp: new Date(messageData.timestamp as string),
        attachments: ((messageData.attachments || []) as Record<string, unknown>[]).map((att) => att.url as string) || [],
      };

      (discordIntegration as unknown as { messageHistory: unknown[]; messageCount: number; lastMessageId: string }).messageHistory.push(message);
      (discordIntegration as unknown as { messageCount: number }).messageCount += 1;
      (discordIntegration as unknown as { lastMessageId: string }).lastMessageId = messageData.id as string;

      const mh = (discordIntegration as unknown as { messageHistory: unknown[] }).messageHistory;
      if (mh.length > 100) {
        (discordIntegration as unknown as { messageHistory: unknown[] }).messageHistory = mh.slice(-100);
      }

      await (discordIntegration as unknown as { save: () => Promise<void> }).save();

      await this.triggerSummarization();
    } catch (error) {
      console.error('Error handling message creation:', error);
    }
  }

  async handleMessageUpdate(messageData: Record<string, unknown>): Promise<void> {
    try {
      const discordIntegration = this.integration as IntegrationDoc;
      if (messageData.channel_id !== discordIntegration.platformIntegration?.channelId) {
        return;
      }

      const mh = (discordIntegration as unknown as { messageHistory: Array<Record<string, unknown>> }).messageHistory;
      const messageIndex = mh.findIndex(
        (msg) => msg.messageId === messageData.id,
      );

      if (messageIndex !== -1) {
        mh[messageIndex] = {
          messageId: messageData.id as string,
          content: messageData.content as string,
          author: (messageData.author as Record<string, unknown>)?.username as string,
          timestamp: new Date(messageData.timestamp as string),
          attachments: ((messageData.attachments || []) as Record<string, unknown>[]).map((att) => att.url as string) || [],
        };

        await (discordIntegration as unknown as { save: () => Promise<void> }).save();
      }
    } catch (error) {
      console.error('Error handling message update:', error);
    }
  }

  async handleMessageDelete(messageData: Record<string, unknown>): Promise<void> {
    try {
      const discordIntegration = this.integration as IntegrationDoc;
      if (messageData.channel_id !== discordIntegration.platformIntegration?.channelId) {
        return;
      }

      const di = discordIntegration as unknown as { messageHistory: Array<Record<string, unknown>> };
      di.messageHistory = di.messageHistory.filter(
        (msg) => msg.messageId !== messageData.id,
      );

      await (discordIntegration as unknown as { save: () => Promise<void> }).save();
    } catch (error) {
      console.error('Error handling message deletion:', error);
    }
  }

  async syncRecentMessages(timeRangeHours = 1, options: SyncOptions = {}): Promise<SyncResult> {
    try {
      if (!(this.integration as IntegrationDoc)?.config?.webhookListenerEnabled) {
        throw new Error('Discord sync not enabled for this integration');
      }

      const integration = await Integration.findById(this.integrationId).lean() as IntegrationDoc | null;
      const buffer = integration?.config?.messageBuffer || [];
      const summaryType =
        options.summaryType || (timeRangeHours === 1 ? 'hourly' : 'manual');

      if (!buffer.length) {
        return {
          success: true,
          messageCount: 0,
          content: 'No Discord activity found to sync.',
        };
      }

      const recentMessages = buffer
        .map((msg) => ({
          author: msg.authorName,
          content: msg.content,
          timestamp: msg.timestamp,
        }))
        .filter((msg) => msg.author && msg.content);

      if (recentMessages.length === 0) {
        return {
          success: true,
          messageCount: 0,
          content: 'No Discord activity found to sync.',
        };
      }

      const timestamps = recentMessages
        .map((msg) => new Date(msg.timestamp as string).getTime())
        .filter((value) => !Number.isNaN(value))
        .sort((a, b) => a - b);
      const timeRange = {
        start: timestamps.length ? new Date(timestamps[0]) : new Date(),
        end: timestamps.length ? new Date(timestamps[timestamps.length - 1]) : new Date(),
      };
      const discordSummary = await (this.commandService as {
        createDiscordSummary: (msgs: unknown[], start: Date, end: Date) => Promise<unknown>;
      }).createDiscordSummary(
        recentMessages,
        timeRange.start,
        timeRange.end,
      );

      // eslint-disable-next-line global-require
      const AgentEventService = require('./agentEventService');
      // eslint-disable-next-line global-require
      const { AgentInstallation } = require('../models/AgentRegistry');
      let installations: Array<{ instanceId?: string }> = [];
      try {
        installations = await AgentInstallation.find({
          agentName: 'commonly-bot',
          podId: (this.integration as IntegrationDoc).podId,
          status: 'active',
        }).lean() as Array<{ instanceId?: string }>;
      } catch (err) {
        const e = err as { message?: string };
        console.warn('Discord sync agent lookup failed:', e.message);
      }

      const targets = installations.length > 0 ? installations : [{ instanceId: 'default' }];

      await Promise.all(
        targets.map((installation) => (
          AgentEventService.enqueue({
            agentName: 'commonly-bot',
            instanceId: installation.instanceId || 'default',
            podId: (this.integration as IntegrationDoc).podId,
            type: 'discord.summary',
            payload: {
              summary: discordSummary,
              integrationId: (this.integration as IntegrationDoc)._id?.toString(),
              source: 'discord',
            },
          })
        )),
      );

      {
        // eslint-disable-next-line global-require
        const DiscordSummaryHistory = require('../models/DiscordSummaryHistory');
        const summaryRecord = new DiscordSummaryHistory({
          integrationId: (this.integration as IntegrationDoc)._id,
          summaryType,
          content: (discordSummary as Record<string, unknown>).content,
          messageCount: recentMessages.length,
          timeRange,
          postedToCommonly: false,
          postedToDiscord: false,
        });
        await summaryRecord.save();

        await Integration.findByIdAndUpdate(this.integrationId, {
          'config.messageBuffer': [],
          'config.lastSummaryAt': new Date(),
        });

        return {
          success: true,
          messageCount: recentMessages.length,
          content: `Queued ${recentMessages.length} Discord message(s) for Commonly Bot.`,
        };
      }
    } catch (error) {
      const err = error as { message?: string };
      console.error('Error syncing Discord messages:', error);
      return {
        success: false,
        messageCount: 0,
        content: `Failed to sync Discord messages: ${err.message}`,
      };
    }
  }

  async triggerSummarization(): Promise<void> {
    try {
      const discordIntegration = this.integration as unknown as {
        recentMessages?: Array<{ author: string; content: string }>;
      };
      const { recentMessages } = discordIntegration;

      if (recentMessages && recentMessages.length >= 10) {
        const messageTexts = recentMessages
          .slice(-10)
          .map((msg) => `${msg.author}: ${msg.content}`)
          .join('\n');

        const summary = await summarizerService.summarizeText(messageTexts, {
          source: 'discord',
          integrationId: this.integrationId,
        });

        console.log('Discord summary generated:', summary);
      }
    } catch (error) {
      console.error('Error triggering summarization:', error);
    }
  }

  async handleSlashCommand(commandName: string, _interaction: unknown): Promise<CommandResult> {
    try {
      if (!this.commandService) {
        return {
          success: false,
          content: '❌ Command service not initialized.',
        };
      }

      const cs = this.commandService as {
        handleSummaryCommand: () => Promise<CommandResult>;
        handleStatusCommand: () => Promise<CommandResult>;
        handleEnableCommand: () => Promise<CommandResult>;
        handleDisableCommand: () => Promise<CommandResult>;
        handlePushCommand: (service: DiscordService) => Promise<CommandResult>;
      };

      switch (commandName) {
        case 'commonly-summary':
          return await cs.handleSummaryCommand();

        case 'discord-status':
          return await cs.handleStatusCommand();

        case 'discord-enable':
          return await cs.handleEnableCommand();

        case 'discord-disable':
          return await cs.handleDisableCommand();

        case 'discord-push':
          return await cs.handlePushCommand(this);

        default:
          return {
            success: false,
            content: '❌ Unknown command.',
          };
      }
    } catch (error) {
      console.error('Error handling slash command:', error);
      return {
        success: false,
        content: '❌ An error occurred while processing the command.',
      };
    }
  }

  async registerSlashCommands(guildId: string | null = null): Promise<boolean> {
    try {
      const targetGuildId =
        guildId ||
        (this.integration as IntegrationDoc)?.platformIntegration?.serverId ||
        (this.integration as IntegrationDoc)?.config?.serverId;

      if (!targetGuildId) {
        throw new Error('Guild ID is required for command registration');
      }

      console.log(`🔧 Registering commands for guild: ${targetGuildId}`);

      const commands = [
        {
          name: 'commonly-summary',
          description: 'Get the most recent summary from the linked chat pod',
          type: 1,
        },
        {
          name: 'discord-status',
          description: 'Show the status of Discord integration',
          type: 1,
        },
        {
          name: 'discord-enable',
          description: 'Enable webhook listener for Discord channel',
          type: 1,
        },
        {
          name: 'discord-disable',
          description: 'Disable webhook listener for Discord channel',
          type: 1,
        },
      ];

      const url = `https://discord.com/api/v10/applications/${config.clientId}/guilds/${targetGuildId}/commands`;

      const response = await axios.put(url, commands, {
        headers: {
          Authorization: `Bot ${config.botToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 200 || response.status === 201) {
        console.log(
          `✅ Successfully registered ${commands.length} commands for guild ${targetGuildId}`,
        );

        if (this.integration) {
          await Integration.findByIdAndUpdate(this.integrationId, {
            'config.commandsRegistered': true,
            'config.lastCommandRegistration': new Date(),
            'config.registeredGuildId': targetGuildId,
          });
        }

        return true;
      }
      throw new Error(`Discord API returned status ${response.status}`);
    } catch (error) {
      const err = error as { message?: string };
      console.error('❌ Failed to register commands:', err.message);

      if (this.integration) {
        await Integration.findByIdAndUpdate(this.integrationId, {
          'config.commandsRegistered': false,
          'config.lastRegistrationError': err.message,
          'config.lastRegistrationAttempt': new Date(),
        });
      }

      return false;
    }
  }

  static async registerCommandsForAllIntegrations(): Promise<BulkRegistrationResult> {
    try {
      console.log(
        '🚀 Starting Discord command registration for all integrations...',
      );

      const integrations = await Integration.find({
        type: 'discord',
        isActive: true,
      }) as IntegrationDoc[];

      if (integrations.length === 0) {
        console.log('ℹ️  No active Discord integrations found');
        return { success: true, registered: 0, failed: 0 };
      }

      console.log(
        `📋 Found ${integrations.length} active Discord integration(s)`,
      );

      let registered = 0;
      let failed = 0;
      const results: BulkRegistrationResult['results'] = [];

      for (const integration of integrations) {
        try {
          const guildId =
            integration.platformIntegration?.serverId ||
            integration.config?.serverId;

          if (!guildId) {
            console.log(`⚠️  Integration ${integration._id}: Missing guild ID`);
            failed++;
            results!.push({
              integrationId: integration._id,
              success: false,
              error: 'Missing guild ID',
            });
            continue;
          }

          console.log(
            `🔧 Registering commands for integration ${integration._id} (Guild: ${guildId})`,
          );

          const tempService = new DiscordService(integration._id);
          await tempService.initialize();

          const success = await tempService.registerSlashCommands(guildId);

          if (success) {
            registered++;
            results!.push({
              integrationId: integration._id,
              guildId,
              success: true,
            });
            console.log(
              `✅ Successfully registered commands for guild ${guildId}`,
            );
          } else {
            failed++;
            results!.push({
              integrationId: integration._id,
              guildId,
              success: false,
              error: 'Registration failed',
            });
            console.log(`❌ Failed to register commands for guild ${guildId}`);
          }
        } catch (error) {
          const err = error as { message?: string };
          failed++;
          results!.push({
            integrationId: integration._id,
            success: false,
            error: err.message,
          });
          console.error(
            `❌ Error registering commands for integration ${integration._id}:`,
            err.message,
          );
        }
      }

      console.log('\n📊 Registration Summary:');
      console.log(`   ✅ Successfully registered: ${registered}`);
      console.log(`   ❌ Failed: ${failed}`);
      console.log(`   📋 Total integrations: ${integrations.length}`);

      return {
        success: failed === 0,
        registered,
        failed,
        total: integrations.length,
        results,
      };
    } catch (error) {
      const err = error as { message?: string };
      console.error('❌ Error in bulk command registration:', error);
      return { success: false, error: err.message };
    }
  }

  async verifyCommandRegistration(guildId: string | null = null): Promise<VerifyCommandResult> {
    try {
      const targetGuildId =
        guildId ||
        (this.integration as IntegrationDoc)?.platformIntegration?.serverId ||
        (this.integration as IntegrationDoc)?.config?.serverId;

      if (!targetGuildId) {
        throw new Error('Guild ID is required for verification');
      }

      const url = `https://discord.com/api/v10/applications/${config.clientId}/guilds/${targetGuildId}/commands`;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${config.botToken}`,
        },
      });

      if (response.status === 200) {
        const registeredCommands = response.data as Array<{ name: string }>;
        const expectedCommands = [
          'commonly-summary',
          'discord-status',
          'discord-enable',
          'discord-disable',
        ];
        const foundCommands = registeredCommands.map((cmd) => cmd.name);

        const missingCommands = expectedCommands.filter(
          (cmd) => !foundCommands.includes(cmd),
        );

        return {
          success: missingCommands.length === 0,
          registeredCommands: foundCommands,
          missingCommands,
          totalExpected: expectedCommands.length,
          totalFound: foundCommands.length,
        };
      }
      throw new Error(`Discord API returned status ${response.status}`);
    } catch (error) {
      const err = error as { message?: string };
      console.error('❌ Error verifying command registration:', err.message);
      return { success: false, error: err.message };
    }
  }

  async handleInteraction(interaction: InteractionData): Promise<InteractionResponse | null> {
    try {
      if (interaction.type === 2) {
        const commandName = interaction.data?.name as string;
        const result = await this.handleSlashCommand(commandName, interaction);

        const responseData: InteractionResponse = {
          type: 4,
          data: {
            content: result.content,
            flags: result.success ? 0 : 64,
          },
        };

        return responseData;
      }

      return null;
    } catch (error) {
      console.error('Error handling interaction:', error);
      return {
        type: 4,
        data: {
          content: '❌ An error occurred while processing the interaction.',
          flags: 64,
        },
      };
    }
  }

  async sendFollowupMessage(interactionToken: string, message: string, options: FollowupOptions = {}): Promise<unknown> {
    try {
      const { ephemeral = false, embeds = [], components = [] } = options;

      const payload: Record<string, unknown> = {
        content: message,
        flags: ephemeral ? 64 : 0,
      };

      if (embeds.length > 0) {
        payload.embeds = embeds;
      }

      if (components.length > 0) {
        payload.components = components;
      }

      const response = await axios.post(
        `https://discord.com/api/v10/webhooks/${config.applicationId}/${interactionToken}`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error('Error sending followup message:', error);
      throw error;
    }
  }

  async editOriginalResponse(interactionToken: string, message: string, options: FollowupOptions = {}): Promise<unknown> {
    try {
      const { embeds = [], components = [] } = options;

      const payload: Record<string, unknown> = {
        content: message,
      };

      if (embeds.length > 0) {
        payload.embeds = embeds;
      }

      if (components.length > 0) {
        payload.components = components;
      }

      const response = await axios.patch(
        `https://discord.com/api/v10/webhooks/${config.applicationId}/${interactionToken}/messages/@original`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error('Error editing original response:', error);
      throw error;
    }
  }

  async deleteOriginalResponse(interactionToken: string): Promise<boolean> {
    try {
      await axios.delete(
        `https://discord.com/api/v10/webhooks/${config.applicationId}/${interactionToken}/messages/@original`,
      );
      return true;
    } catch (error) {
      console.error('Error deleting original response:', error);
      throw error;
    }
  }

  async deferResponse(interactionToken: string, ephemeral = false): Promise<unknown> {
    try {
      const payload = {
        type: 5,
        data: {
          flags: ephemeral ? 64 : 0,
        },
      };

      const response = await axios.post(
        `https://discord.com/api/v10/interactions/${interactionToken}/callback`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error('Error deferring response:', error);
      throw error;
    }
  }
}

module.exports = DiscordService;

export {};
