const { Client, GatewayIntentBits } = require('discord.js');
const Integration = require('../models/Integration');
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');

const CACHE_TTL_MS = 60 * 1000;

class DiscordGatewayService {
  constructor() {
    this.client = null;
    this.clientReady = false;
    this.starting = false;
    this.channelCache = new Map();
    this.cacheExpiresAt = 0;
  }

  async start() {
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

      this.client.on('error', (error) => {
        console.error('Discord gateway error:', error);
      });

      this.client.on('shardError', (error) => {
        console.error('Discord gateway shard error:', error);
      });

      this.client.on('messageCreate', (message) => {
        this.handleMessageCreate(message).catch((error) => {
          console.error('Discord gateway message handler error:', error);
        });
      });

      await this.client.login(process.env.DISCORD_BOT_TOKEN);
      this.clientReady = true;
      console.log('Discord gateway started');
    } catch (error) {
      console.error('Failed to start Discord gateway:', error);
    } finally {
      this.starting = false;
    }
  }

  async ensureChannelCache() {
    if (Date.now() < this.cacheExpiresAt && this.channelCache.size > 0) {
      return;
    }

    const integrations = await Integration.find({
      type: 'discord',
      isActive: true,
    })
      .select('_id config.channelId config.serverId config.webhookListenerEnabled config.maxBufferSize')
      .lean();

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

  static buildBufferMessage(message) {
    const attachments = Array.from(message.attachments.values()).map(
      (attachment) => attachment.url,
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

  async handleMessageCreate(message) {
    if (!message?.guild || !message?.channel) {
      return;
    }

    if (message.author?.bot) {
      return;
    }

    const bufferMessage = DiscordGatewayService.buildBufferMessage(message);
    if (!bufferMessage || (!bufferMessage.content && !bufferMessage.attachments.length)) {
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

module.exports = new DiscordGatewayService();
