const axios = require('axios');
const { Client, Intents } = require('discord.js');
const DiscordIntegration = require('../models/DiscordIntegration');
const Integration = require('../models/Integration');
const summarizerService = require('./summarizerService');
const config = require('../config/discord');

/**
 * Discord Integration Service
 * Handles Discord bot integration and webhook management
 */
class DiscordService {
  constructor(integrationId) {
    this.integrationId = integrationId;
    this.client = new Client({
      intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_WEBHOOKS,
      ],
    });

    // Initialize bot with universal token
    this.client.login(config.botToken);
  }

  async initialize() {
    try {
      const integration = await Integration.findById(this.integrationId)
        .populate('platformIntegration');

      if (!integration) {
        throw new Error('Integration not found');
      }

      this.integration = integration;
      return true;
    } catch (error) {
      console.error('Error initializing Discord service:', error);
      return false;
    }
  }

  async createWebhook(channelId) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        throw new Error(config.errors.CHANNEL_NOT_FOUND);
      }

      // Check if bot has necessary permissions
      const permissions = channel.permissionsFor(this.client.user);
      if (!permissions.has(config.requiredPermissions)) {
        throw new Error(config.errors.MISSING_PERMISSIONS);
      }

      // Create webhook
      const webhook = await channel.createWebhook(config.webhookName, {
        avatar: config.webhookAvatar,
      });

      return webhook;
    } catch (error) {
      console.error('Error creating webhook:', error);
      throw error;
    }
  }

  async connect() {
    try {
      const guild = await this.client.guilds.fetch(this.integration.platformIntegration.serverId);
      if (!guild) {
        throw new Error(config.errors.SERVER_NOT_FOUND);
      }

      const channel = await guild.channels.fetch(this.integration.platformIntegration.channelId);
      if (!channel) {
        throw new Error(config.errors.CHANNEL_NOT_FOUND);
      }

      // Create webhook if it doesn't exist
      if (!this.integration.platformIntegration.webhookUrl) {
        const webhook = await this.createWebhook(channel.id);

        // Update integration with webhook details
        await DiscordIntegration.findByIdAndUpdate(
          this.integration.platformIntegration._id,
          {
            webhookUrl: webhook.url,
            webhookId: webhook.id,
          },
        );
      }

      // Update integration status
      await Integration.findByIdAndUpdate(this.integrationId, {
        status: 'connected',
        lastSync: new Date(),
      });

      return true;
    } catch (error) {
      console.error('Error connecting to Discord:', error);

      // Update integration status
      await Integration.findByIdAndUpdate(this.integrationId, {
        status: 'error',
        lastError: error.message,
      });

      return false;
    }
  }

  async disconnect() {
    try {
      // Remove webhook if it exists
      if (this.integration.platformIntegration.webhookId) {
        try {
          const channel = await this.client.channels.fetch(this.integration.platformIntegration.channelId);
          const webhooks = await channel.fetchWebhooks();
          const webhook = webhooks.get(this.integration.platformIntegration.webhookId);
          if (webhook) {
            await webhook.delete();
          }
        } catch (error) {
          console.warn('Error removing webhook:', error);
        }
      }

      // Update integration status
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

  async sendMessage(message) {
    try {
      if (!this.integration.platformIntegration.webhookUrl) {
        throw new Error('Webhook URL not found');
      }

      // Apply rate limiting
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

      // Send message via webhook
      const response = await fetch(this.integration.platformIntegration.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message,
          username: config.webhookName,
          avatar_url: config.webhookAvatar,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Update message history
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

  async getStats() {
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

      return stats[0];
    } catch (error) {
      console.error('Error getting stats:', error);
      return null;
    }
  }

  /**
   * Fetch recent messages from Discord channel
   */
  async fetchMessages(options = {}) {
    try {
      const { limit = 50, before } = options;

      const url = `${this.baseUrl}/channels/${this.discordIntegration.channelId}/messages`;
      const params = { limit };

      if (before) {
        params.before = before;
      }

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${this.discordIntegration.botToken}`,
          'Content-Type': 'application/json',
        },
        params,
      });

      const messages = response.data.map((msg) => ({
        messageId: msg.id,
        content: msg.content,
        author: msg.author.username,
        timestamp: new Date(msg.timestamp),
        attachments: msg.attachments.map((att) => att.url),
        embeds: msg.embeds,
      }));

      // Update message history
      await this.updateMessageHistory(messages);

      return messages;
    } catch (error) {
      console.error('Error fetching Discord messages:', error);
      throw error;
    }
  }

  /**
   * Get Discord channels for the server
   */
  async getChannels() {
    try {
      const url = `${this.baseUrl}/guilds/${this.discordIntegration.serverId}/channels`;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${this.discordIntegration.botToken}`,
          'Content-Type': 'application/json',
        },
      });

      return response.data
        .filter((channel) => channel.type === 0) // Text channels only
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          topic: channel.topic,
          position: channel.position,
        }));
    } catch (error) {
      console.error('Error fetching Discord channels:', error);
      throw error;
    }
  }

  /**
   * Get connection status
   */
  async getStatus() {
    try {
      await this.initialize();
      return this.integration.status;
    } catch (error) {
      return 'error';
    }
  }

  /**
   * Test the Discord connection
   */
  async testConnection() {
    try {
      // Test bot token by fetching bot info
      const botResponse = await axios.get(`${this.baseUrl}/users/@me`, {
        headers: {
          Authorization: `Bot ${this.discordIntegration.botToken}`,
          'Content-Type': 'application/json',
        },
      });

      // Test webhook by sending a test message (optional)
      // This could be implemented if needed

      return botResponse.status === 200;
    } catch (error) {
      console.error('Error testing Discord connection:', error);
      return false;
    }
  }

  /**
   * Validate Discord configuration
   */
  static async validateConfig(discordConfig) {
    const requiredFields = ['serverId', 'channelId', 'webhookUrl', 'botToken'];

    const missingFields = requiredFields.filter((field) => !discordConfig[field]);
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate webhook URL format
    if (!discordConfig.webhookUrl.includes('discord.com/api/webhooks/')) {
      throw new Error('Invalid Discord webhook URL format');
    }

    return true;
  }

  /**
   * Handle Discord webhook events
   */
  async handleWebhook(event) {
    try {
      // Handle different event types
      switch (event.type) {
        case 1: // PING
          return { type: 1 }; // PONG response

        case 0: // MESSAGE_CREATE
          await this.handleMessageCreate(event.d);
          break;

        case 3: // MESSAGE_UPDATE
          await this.handleMessageUpdate(event.d);
          break;

        case 4: // MESSAGE_DELETE
          await this.handleMessageDelete(event.d);
          break;

        default:
          console.log('Unhandled Discord event type:', event.type);
      }
    } catch (error) {
      console.error('Error handling Discord webhook:', error);
      throw error;
    }
  }

  /**
   * Handle new message creation
   */
  async handleMessageCreate(messageData) {
    try {
      // Only process messages from the connected channel
      if (messageData.channel_id !== this.discordIntegration.channelId) {
        return;
      }

      const message = {
        messageId: messageData.id,
        content: messageData.content,
        author: messageData.author.username,
        timestamp: new Date(messageData.timestamp),
        attachments: messageData.attachments?.map((att) => att.url) || [],
      };

      // Add to message history
      this.discordIntegration.messageHistory.push(message);
      this.discordIntegration.messageCount += 1;
      this.discordIntegration.lastMessageId = messageData.id;

      // Keep only last 100 messages
      if (this.discordIntegration.messageHistory.length > 100) {
        this.discordIntegration.messageHistory = this.discordIntegration.messageHistory.slice(-100);
      }

      await this.discordIntegration.save();
      await this.updateStatus('connected');

      // Trigger summarization if needed
      await this.triggerSummarization();
    } catch (error) {
      console.error('Error handling message creation:', error);
    }
  }

  /**
   * Handle message updates
   */
  async handleMessageUpdate(messageData) {
    try {
      if (messageData.channel_id !== this.discordIntegration.channelId) {
        return;
      }

      // Update message in history
      const messageIndex = this.discordIntegration.messageHistory.findIndex(
        (msg) => msg.messageId === messageData.id,
      );

      if (messageIndex !== -1) {
        this.discordIntegration.messageHistory[messageIndex] = {
          messageId: messageData.id,
          content: messageData.content,
          author: messageData.author.username,
          timestamp: new Date(messageData.timestamp),
          attachments: messageData.attachments?.map((att) => att.url) || [],
        };

        await this.discordIntegration.save();
      }
    } catch (error) {
      console.error('Error handling message update:', error);
    }
  }

  /**
   * Handle message deletion
   */
  async handleMessageDelete(messageData) {
    try {
      if (messageData.channel_id !== this.discordIntegration.channelId) {
        return;
      }

      // Remove message from history
      this.discordIntegration.messageHistory = this.discordIntegration.messageHistory.filter(
        (msg) => msg.messageId !== messageData.id,
      );

      await this.discordIntegration.save();
    } catch (error) {
      console.error('Error handling message deletion:', error);
    }
  }

  /**
   * Update message history
   */
  async updateMessageHistory(messages) {
    try {
      // Add new messages to history
      messages.forEach((message) => {
        const exists = this.discordIntegration.messageHistory.some(
          (msg) => msg.messageId === message.messageId,
        );

        if (!exists) {
          this.discordIntegration.messageHistory.push(message);
          this.discordIntegration.messageCount += 1;
        }
      });

      // Keep only last 100 messages
      if (this.discordIntegration.messageHistory.length > 100) {
        this.discordIntegration.messageHistory = this.discordIntegration.messageHistory.slice(-100);
      }

      await this.discordIntegration.save();
    } catch (error) {
      console.error('Error updating message history:', error);
    }
  }

  /**
   * Trigger message summarization
   */
  async triggerSummarization() {
    try {
      // Get recent messages for summarization
      const { recentMessages } = this.discordIntegration;

      if (recentMessages.length >= 10) { // Summarize every 10 messages
        const messageTexts = recentMessages
          .slice(-10)
          .map((msg) => `${msg.author}: ${msg.content}`)
          .join('\n');

        const summary = await summarizerService.summarizeText(messageTexts, {
          source: 'discord',
          integrationId: this.integrationId,
        });

        // Store summary or send to chat
        console.log('Discord summary generated:', summary);
      }
    } catch (error) {
      console.error('Error triggering summarization:', error);
    }
  }
}

module.exports = DiscordService;
