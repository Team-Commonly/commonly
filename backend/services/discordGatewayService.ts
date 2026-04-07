// eslint-disable-next-line global-require
const { Client, GatewayIntentBits } = require('discord.js');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');

const CACHE_TTL_MS = 60 * 1000;

interface DiscordClient {
  on(event: string, handler: (...args: unknown[]) => void): void;
  login(token: string): Promise<unknown>;
}

interface ChannelTarget {
  integrationId: unknown;
  webhookListenerEnabled: boolean;
  maxBufferSize: number;
}

interface IntegrationDoc {
  _id?: unknown;
  config?: {
    channelId?: string;
    serverId?: string;
    webhookListenerEnabled?: boolean;
    maxBufferSize?: number;
  };
}

interface DiscordMessage {
  guild?: { id: string };
  channel?: { id: string };
  author?: { id?: string; username?: string; bot?: boolean };
  member?: { displayName?: string };
  content?: string;
  id?: string;
  createdAt?: Date;
  attachments?: Map<string, { url: string }>;
}

interface BufferMessage {
  content?: string;
  attachments?: string[];
  [key: string]: unknown;
}

class DiscordGatewayService {
  private client: DiscordClient | null;

  private clientReady: boolean;

  private starting: boolean;

  private channelCache: Map<string, ChannelTarget[]>;

  private cacheExpiresAt: number;

  constructor() {
    this.client = null;
    this.clientReady = false;
    this.starting = false;
    this.channelCache = new Map();
    this.cacheExpiresAt = 0;
  }

  async start(): Promise<void> {
    if (this.clientReady || this.starting) {
      return;
    }

    if (!process.env.DISCORD_BOT_TOKEN) {
      console.warn('Discord bot token not configured, gateway disabled');
      return;
    }

    this.starting = true;
    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      this.client!.on('error', (error: unknown) => {
        console.error('Discord gateway error:', error);
      });

      this.client!.on('shardError', (error: unknown) => {
        console.error('Discord gateway shard error:', error);
      });

      this.client!.on('messageCreate', (message: unknown) => {
        this.handleMessageCreate(message as DiscordMessage).catch((error: unknown) => {
          console.error('Discord gateway message handler error:', error);
        });
      });

      await this.client!.login(process.env.DISCORD_BOT_TOKEN);
      this.clientReady = true;
      console.log('Discord gateway started');
    } catch (error) {
      console.error('Failed to start Discord gateway:', error);
    } finally {
      this.starting = false;
    }
  }

  async ensureChannelCache(): Promise<void> {
    if (Date.now() < this.cacheExpiresAt && this.channelCache.size > 0) {
      return;
    }

    const integrations = await Integration.find({
      type: 'discord',
      isActive: true,
    })
      .select('_id config.channelId config.serverId config.webhookListenerEnabled config.maxBufferSize')
      .lean() as IntegrationDoc[];

    this.channelCache.clear();
    integrations.forEach((integration) => {
      const channelId = integration?.config?.channelId;
      const serverId = integration?.config?.serverId;
      if (!channelId || !serverId) {
        return;
      }
      const key = `${serverId}:${channelId}`;
      const existing = this.channelCache.get(key) || [];
      existing.push({
        integrationId: integration._id,
        webhookListenerEnabled: !!integration?.config?.webhookListenerEnabled,
        maxBufferSize: integration?.config?.maxBufferSize || 1000,
      });
      this.channelCache.set(key, existing);
    });

    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  }

  static buildBufferMessage(message: DiscordMessage): BufferMessage {
    const attachments = Array.from((message.attachments || new Map()).values()).map(
      (attachment) => (attachment as { url: string }).url,
    );

    return normalizeBufferMessage({
      messageId: message.id,
      authorId: message.author?.id,
      authorName:
        message.member?.displayName || message.author?.username || 'Unknown',
      content: message.content,
      timestamp: message.createdAt || new Date(),
      attachments,
    });
  }

  async handleMessageCreate(message: DiscordMessage): Promise<void> {
    if (!message?.guild || !message?.channel) {
      return;
    }

    if (message.author?.bot) {
      return;
    }

    const bufferMessage = DiscordGatewayService.buildBufferMessage(message);
    if (!bufferMessage || (!bufferMessage.content && !(bufferMessage.attachments as string[] || []).length)) {
      return;
    }

    await this.ensureChannelCache();
    const key = `${message.guild.id}:${message.channel.id}`;
    const targets = this.channelCache.get(key) || [];

    if (!targets.length) {
      return;
    }

    await Promise.all(
      targets
        .filter((target) => target.webhookListenerEnabled)
        .map((target) => Integration.findByIdAndUpdate(target.integrationId, {
          $push: {
            'config.messageBuffer': {
              $each: [bufferMessage],
              $slice: -1 * (target.maxBufferSize || 1000),
            },
          },
        })),
    );
  }
}

export default new DiscordGatewayService();
