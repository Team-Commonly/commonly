const axios = require("axios");
const { Client, GatewayIntentBits } = require("discord.js");
const DiscordIntegration = require("../models/DiscordIntegration");
const Integration = require("../models/Integration");
const DiscordCommandService = require("./discordCommandService");
const summarizerService = require("./summarizerService");
const config = require("../config/discord");

/**
 * Discord Integration Service
 * Handles Discord bot integration and webhook management
 */
class DiscordService {
  constructor(integrationId) {
    this.integrationId = integrationId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildWebhooks,
      ],
    });

    this.clientReady = false;
    this.client.on("error", (error) => {
      console.error("Discord client error:", error);
    });
    this.client.on("shardError", (error) => {
      console.error("Discord shard error:", error);
    });

    // Initialize command service
    this.commandService = null;
  }

  async ensureClientReady() {
    if (this.clientReady) {
      return true;
    }

    if (!config.botToken) {
      throw new Error("Discord bot token not configured");
    }

    try {
      await this.client.login(config.botToken);
      this.clientReady = true;
      return true;
    } catch (error) {
      console.error("Error logging in Discord client:", error);
      throw error;
    }
  }

  async initialize() {
    try {
      const integration = await Integration.findById(
        this.integrationId,
      ).populate("platformIntegration");

      if (!integration) {
        throw new Error("Integration not found");
      }

      this.integration = integration;

      // Use guild ID as installation ID for better identification
      const guildId =
        integration.platformIntegration?.serverId ||
        integration.config?.serverId;
      const channelId =
        integration.platformIntegration?.channelId ||
        integration.config?.channelId;
      if (!guildId) {
        throw new Error("Guild ID not found in integration");
      }

      // Initialize command service with guild ID as installation ID
      this.commandService = new DiscordCommandService({
        guildId,
        channelId,
        integrationId: this.integrationId,
      });
      await this.commandService.initialize();

      return true;
    } catch (error) {
      console.error("Error initializing Discord service:", error);
      return false;
    }
  }

  async createWebhook(channelId) {
    try {
      await this.ensureClientReady();
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
      console.error("Error creating webhook:", error);
      throw error;
    }
  }

  async connect() {
    try {
      await this.ensureClientReady();
      const guild = await this.client.guilds.fetch(
        this.integration.platformIntegration.serverId,
      );
      if (!guild) {
        throw new Error(config.errors.SERVER_NOT_FOUND);
      }

      const channel = await guild.channels.fetch(
        this.integration.platformIntegration.channelId,
      );
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
        status: "connected",
        lastSync: new Date(),
      });

      return true;
    } catch (error) {
      console.error("Error connecting to Discord:", error);

      // Update integration status
      await Integration.findByIdAndUpdate(this.integrationId, {
        status: "error",
        lastError: error.message,
      });

      return false;
    }
  }

  async disconnect() {
    try {
      await this.ensureClientReady();
      // Remove webhook if it exists
      if (this.integration.platformIntegration.webhookId) {
        try {
          const channel = await this.client.channels.fetch(
            this.integration.platformIntegration.channelId,
          );
          const webhooks = await channel.fetchWebhooks();
          const webhook = webhooks.get(
            this.integration.platformIntegration.webhookId,
          );
          if (webhook) {
            await webhook.delete();
          }
        } catch (error) {
          console.warn("Error removing webhook:", error);
        }
      }

      // Update integration status
      await Integration.findByIdAndUpdate(this.integrationId, {
        status: "disconnected",
        lastSync: new Date(),
      });

      return true;
    } catch (error) {
      console.error("Error disconnecting from Discord:", error);
      return false;
    }
  }

  async sendMessage(message) {
    try {
      if (!this.integration.platformIntegration.webhookUrl) {
        throw new Error("Webhook URL not found");
      }

      // Apply rate limiting
      const now = Date.now();
      const recentMessages = await Integration.find({
        _id: this.integrationId,
        "messageHistory.timestamp": {
          $gt: now - config.messageRateLimit.timeWindow,
        },
      }).count();

      if (recentMessages >= config.messageRateLimit.maxMessages) {
        throw new Error(config.errors.RATE_LIMITED);
      }

      // Send message via webhook
      const response = await fetch(
        this.integration.platformIntegration.webhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

      // Update message history
      await Integration.findByIdAndUpdate(this.integrationId, {
        $push: {
          messageHistory: {
            timestamp: now,
            type: "outgoing",
            content: message,
          },
        },
      });

      return true;
    } catch (error) {
      console.error("Error sending message:", error);
      throw error;
    }
  }

  async getStats() {
    try {
      const stats = await Integration.aggregate([
        { $match: { _id: this.integrationId } },
        {
          $project: {
            messageCount: { $size: "$messageHistory" },
            lastSync: 1,
            status: 1,
            uptime: {
              $subtract: [new Date(), "$createdAt"],
            },
          },
        },
      ]);

      return stats[0];
    } catch (error) {
      console.error("Error getting stats:", error);
      return null;
    }
  }

  /**
   * Fetch recent messages from Discord channel
   */
  async fetchMessages(options = {}) {
    try {
      const { limit = 50, before } = options;

      const channelId = this.integration?.config?.channelId;
      if (!channelId) {
        throw new Error("Channel ID not found in integration config");
      }

      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const params = { limit };

      if (before) {
        params.before = before;
      }

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
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

      // Filter out bot messages for cleaner content
      const filteredMessages = messages.filter((msg) => !msg.author?.bot);

      return filteredMessages;
    } catch (error) {
      console.error("Error fetching Discord messages:", error);
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
          "Content-Type": "application/json",
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
      console.error("Error fetching Discord channels:", error);
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
      return "error";
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
          "Content-Type": "application/json",
        },
      });

      // Test webhook by sending a test message (optional)
      // This could be implemented if needed

      return botResponse.status === 200;
    } catch (error) {
      console.error("Error testing Discord connection:", error);
      return false;
    }
  }

  /**
   * Validate Discord configuration
   */
  static async validateConfig(discordConfig) {
    const requiredFields = ["serverId", "channelId", "webhookUrl", "botToken"];

    const missingFields = requiredFields.filter(
      (field) => !discordConfig[field],
    );
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(", ")}`);
    }

    // Validate webhook URL format
    if (!discordConfig.webhookUrl.includes("discord.com/api/webhooks/")) {
      throw new Error("Invalid Discord webhook URL format");
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
          console.log("Unhandled Discord event type:", event.type);
      }
    } catch (error) {
      console.error("Error handling Discord webhook:", error);
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
        this.discordIntegration.messageHistory =
          this.discordIntegration.messageHistory.slice(-100);
      }

      await this.discordIntegration.save();
      await this.updateStatus("connected");

      // Trigger summarization if needed
      await this.triggerSummarization();
    } catch (error) {
      console.error("Error handling message creation:", error);
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
      console.error("Error handling message update:", error);
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
      this.discordIntegration.messageHistory =
        this.discordIntegration.messageHistory.filter(
          (msg) => msg.messageId !== messageData.id,
        );

      await this.discordIntegration.save();
    } catch (error) {
      console.error("Error handling message deletion:", error);
    }
  }

  /**
   * Sync Discord messages from last hour to Commonly pod
   * Used by both manual /discord-push command and automatic hourly sync
   */
  async syncRecentMessages(timeRangeHours = 1, options = {}) {
    try {
      if (!this.integration?.config?.webhookListenerEnabled) {
        throw new Error("Discord sync not enabled for this integration");
      }

      const integration = await Integration.findById(this.integrationId).lean();
      const buffer = integration?.config?.messageBuffer || [];
      const summaryType =
        options.summaryType || (timeRangeHours === 1 ? "hourly" : "manual");

      if (!buffer.length) {
        return {
          success: true,
          messageCount: 0,
          content: "No Discord activity found to sync.",
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
          content: "No Discord activity found to sync.",
        };
      }

      // Create Discord summary from recent messages
      const timestamps = recentMessages
        .map((msg) => new Date(msg.timestamp).getTime())
        .filter((value) => !Number.isNaN(value))
        .sort((a, b) => a - b);
      const timeRange = {
        start: timestamps.length ? new Date(timestamps[0]) : new Date(),
        end: timestamps.length ? new Date(timestamps[timestamps.length - 1]) : new Date(),
      };
      const discordSummary = await this.commandService.createDiscordSummary(
        recentMessages,
        timeRange.start,
        timeRange.end,
      );

      const AgentEventService = require('./agentEventService');
      const { AgentInstallation } = require('../models/AgentRegistry');
      let installations = [];
      try {
        installations = await AgentInstallation.find({
          agentName: 'commonly-bot',
          podId: this.integration.podId,
          status: 'active',
        }).lean();
      } catch (err) {
        console.warn('Discord sync agent lookup failed:', err.message);
      }

      const targets = installations.length > 0 ? installations : [{ instanceId: 'default' }];

      await Promise.all(
        targets.map((installation) => (
          AgentEventService.enqueue({
            agentName: 'commonly-bot',
            instanceId: installation.instanceId || 'default',
            podId: this.integration.podId,
            type: 'discord.summary',
            payload: {
              summary: discordSummary,
              integrationId: this.integration._id.toString(),
              source: 'discord',
            },
          })
        )),
      );

      {
        // Save to Discord summary history
        const DiscordSummaryHistory = require("../models/DiscordSummaryHistory");
        const summaryRecord = new DiscordSummaryHistory({
          integrationId: this.integration._id,
          summaryType,
          content: discordSummary.content,
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
      console.error("Error syncing Discord messages:", error);
      return {
        success: false,
        messageCount: 0,
        content: `Failed to sync Discord messages: ${error.message}`,
      };
    }
  }

  /**
   * Trigger message summarization
   */
  async triggerSummarization() {
    try {
      // Get recent messages for summarization
      const { recentMessages } = this.discordIntegration;

      if (recentMessages.length >= 10) {
        // Summarize every 10 messages
        const messageTexts = recentMessages
          .slice(-10)
          .map((msg) => `${msg.author}: ${msg.content}`)
          .join("\n");

        const summary = await summarizerService.summarizeText(messageTexts, {
          source: "discord",
          integrationId: this.integrationId,
        });

        // Store summary or send to chat
        console.log("Discord summary generated:", summary);
      }
    } catch (error) {
      console.error("Error triggering summarization:", error);
    }
  }

  /**
   * Handle Discord slash commands
   */
  async handleSlashCommand(commandName, interaction) {
    try {
      if (!this.commandService) {
        return {
          success: false,
          content: "❌ Command service not initialized.",
        };
      }

      switch (commandName) {
        case "commonly-summary":
          return await this.commandService.handleSummaryCommand();

        case "discord-status":
          return await this.commandService.handleStatusCommand();

        case "discord-enable":
          return await this.commandService.handleEnableCommand();

        case "discord-disable":
          return await this.commandService.handleDisableCommand();

        case "discord-push":
          return await this.commandService.handlePushCommand(this);

        default:
          return {
            success: false,
            content: "❌ Unknown command.",
          };
      }
    } catch (error) {
      console.error("Error handling slash command:", error);
      return {
        success: false,
        content: "❌ An error occurred while processing the command.",
      };
    }
  }

  /**
   * Register slash commands for a specific guild (server)
   * This is the main method for command registration
   */
  async registerSlashCommands(guildId = null) {
    try {
      // Use provided guildId or get from integration
      const targetGuildId =
        guildId ||
        this.integration?.platformIntegration?.serverId ||
        this.integration?.config?.serverId;

      if (!targetGuildId) {
        throw new Error("Guild ID is required for command registration");
      }

      console.log(`🔧 Registering commands for guild: ${targetGuildId}`);

      // Define the slash commands
      const commands = [
        {
          name: "commonly-summary",
          description: "Get the most recent summary from the linked chat pod",
          type: 1, // CHAT_INPUT
        },
        {
          name: "discord-status",
          description: "Show the status of Discord integration",
          type: 1,
        },
        {
          name: "discord-enable",
          description: "Enable webhook listener for Discord channel",
          type: 1,
        },
        {
          name: "discord-disable",
          description: "Disable webhook listener for Discord channel",
          type: 1,
        },
      ];

      // Register commands with Discord API
      const url = `https://discord.com/api/v10/applications/${config.clientId}/guilds/${targetGuildId}/commands`;

      const response = await axios.put(url, commands, {
        headers: {
          Authorization: `Bot ${config.botToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.status === 200 || response.status === 201) {
        console.log(
          `✅ Successfully registered ${commands.length} commands for guild ${targetGuildId}`,
        );

        // Update integration with registration info
        if (this.integration) {
          await Integration.findByIdAndUpdate(this.integrationId, {
            "config.commandsRegistered": true,
            "config.lastCommandRegistration": new Date(),
            "config.registeredGuildId": targetGuildId,
          });
        }

        return true;
      }
      throw new Error(`Discord API returned status ${response.status}`);
    } catch (error) {
      console.error("❌ Failed to register commands:", error.message);

      // Update integration with error info
      if (this.integration) {
        await Integration.findByIdAndUpdate(this.integrationId, {
          "config.commandsRegistered": false,
          "config.lastRegistrationError": error.message,
          "config.lastRegistrationAttempt": new Date(),
        });
      }

      return false;
    }
  }

  /**
   * Register commands for all active Discord integrations
   * This is used during deployment
   */
  static async registerCommandsForAllIntegrations() {
    try {
      console.log(
        "🚀 Starting Discord command registration for all integrations...",
      );

      const integrations = await Integration.find({
        type: "discord",
        isActive: true,
      });

      if (integrations.length === 0) {
        console.log("ℹ️  No active Discord integrations found");
        return { success: true, registered: 0, failed: 0 };
      }

      console.log(
        `📋 Found ${integrations.length} active Discord integration(s)`,
      );

      let registered = 0;
      let failed = 0;
      const results = [];

      for (const integration of integrations) {
        try {
          const guildId =
            integration.platformIntegration?.serverId ||
            integration.config?.serverId;

          if (!guildId) {
            console.log(`⚠️  Integration ${integration._id}: Missing guild ID`);
            failed++;
            results.push({
              integrationId: integration._id,
              success: false,
              error: "Missing guild ID",
            });
            continue;
          }

          console.log(
            `🔧 Registering commands for integration ${integration._id} (Guild: ${guildId})`,
          );

          // Create a temporary service instance for registration
          const tempService = new DiscordService(integration._id);
          await tempService.initialize();

          const success = await tempService.registerSlashCommands(guildId);

          if (success) {
            registered++;
            results.push({
              integrationId: integration._id,
              guildId,
              success: true,
            });
            console.log(
              `✅ Successfully registered commands for guild ${guildId}`,
            );
          } else {
            failed++;
            results.push({
              integrationId: integration._id,
              guildId,
              success: false,
              error: "Registration failed",
            });
            console.log(`❌ Failed to register commands for guild ${guildId}`);
          }
        } catch (error) {
          failed++;
          results.push({
            integrationId: integration._id,
            success: false,
            error: error.message,
          });
          console.error(
            `❌ Error registering commands for integration ${integration._id}:`,
            error.message,
          );
        }
      }

      console.log("\n📊 Registration Summary:");
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
      console.error("❌ Error in bulk command registration:", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify command registration status
   * Checks if commands are properly registered for a guild
   */
  async verifyCommandRegistration(guildId = null) {
    try {
      const targetGuildId =
        guildId ||
        this.integration?.platformIntegration?.serverId ||
        this.integration?.config?.serverId;

      if (!targetGuildId) {
        throw new Error("Guild ID is required for verification");
      }

      const url = `https://discord.com/api/v10/applications/${config.clientId}/guilds/${targetGuildId}/commands`;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${config.botToken}`,
        },
      });

      if (response.status === 200) {
        const registeredCommands = response.data;
        const expectedCommands = [
          "commonly-summary",
          "discord-status",
          "discord-enable",
          "discord-disable",
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
      console.error("❌ Error verifying command registration:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle Discord interaction (slash command response)
   */
  async handleInteraction(interaction) {
    try {
      if (interaction.type === 2) {
        // APPLICATION_COMMAND
        const commandName = interaction.data.name;
        const result = await this.handleSlashCommand(commandName, interaction);

        // Send response back to Discord
        const responseData = {
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content: result.content,
            flags: result.success ? 0 : 64, // 64 = EPHEMERAL for errors
          },
        };

        return responseData;
      }

      return null;
    } catch (error) {
      console.error("Error handling interaction:", error);
      return {
        type: 4,
        data: {
          content: "❌ An error occurred while processing the interaction.",
          flags: 64, // EPHEMERAL
        },
      };
    }
  }

  /**
   * Send followup message using interaction token
   * Follows Discord's official followup message format
   */
  async sendFollowupMessage(interactionToken, message, options = {}) {
    try {
      const { ephemeral = false, embeds = [], components = [] } = options;

      const payload = {
        content: message,
        flags: ephemeral ? 64 : 0, // 64 = EPHEMERAL
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
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error("Error sending followup message:", error);
      throw error;
    }
  }

  /**
   * Edit original interaction response
   */
  async editOriginalResponse(interactionToken, message, options = {}) {
    try {
      const { embeds = [], components = [] } = options;

      const payload = {
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
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error("Error editing original response:", error);
      throw error;
    }
  }

  /**
   * Delete original interaction response
   */
  async deleteOriginalResponse(interactionToken) {
    try {
      await axios.delete(
        `https://discord.com/api/v10/webhooks/${config.applicationId}/${interactionToken}/messages/@original`,
      );
      return true;
    } catch (error) {
      console.error("Error deleting original response:", error);
      throw error;
    }
  }

  /**
   * Defer response for long-running operations
   * Use this when processing might take longer than 3 seconds
   */
  async deferResponse(interactionToken, ephemeral = false) {
    try {
      const payload = {
        type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        data: {
          flags: ephemeral ? 64 : 0,
        },
      };

      const response = await axios.post(
        `https://discord.com/api/v10/interactions/${interactionToken}/callback`,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error("Error deferring response:", error);
      throw error;
    }
  }
}

module.exports = DiscordService;
