const Integration = require("../models/Integration");
const DiscordSummaryHistory = require("../models/DiscordSummaryHistory");
const Summary = require("../models/Summary");
const DiscordService = require("./discordService");
const CommonlyBotService = require("./commonlyBotService");
const summarizerService = require("./summarizerService");

/**
 * Discord Command Service
 * Handles Discord bot commands and interactions
 */
class DiscordCommandService {
  constructor(options = {}) {
    if (typeof options === "string") {
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

  /**
   * Initialize the service with integration data
   */
  async initialize() {
    try {
      if (this.integrationId) {
        this.integration = await Integration.findOne({
          _id: this.integrationId,
          type: "discord",
          isActive: true,
        });
      }

      if (!this.integration && this.channelId) {
        const channelQuery = {
          type: "discord",
          isActive: true,
          "config.channelId": this.channelId,
        };
        if (this.guildId) {
          channelQuery["config.serverId"] = this.guildId;
        }
        this.integration = await Integration.findOne(channelQuery);
      }

      if (!this.integration && this.guildId) {
        // Fallback: match by server ID if no channel match exists
        this.integration = await Integration.findOne({
          type: "discord",
          isActive: true,
          "config.serverId": this.guildId,
        });
      }

      if (!this.integration) {
        throw new Error(
          `Integration not found for ${this.channelId ? "channel" : "guild"} ${
            this.channelId || this.guildId || "unknown"
          }`,
        );
      }
      return true;
    } catch (error) {
      console.error("Error initializing Discord command service:", error);
      return false;
    }
  }

  /**
   * Handle /commonly-summary command
   * Fetches the most recent summary from the linked Commonly chat pod
   * This shows what's happening in Commonly, not Discord-specific activity
   */
  async handleSummaryCommand() {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content:
            "❌ Discord integration not found. Please install the bot first.",
        };
      }

      // Always get the latest pod-specific summary from Commonly DB
      // This command shows what's happening in the linked Commonly pod
      const latestSummary = await Summary.findOne({
        type: "chats",
        podId: this.integration.podId,
      }).sort({ createdAt: -1 });

      if (!latestSummary) {
        return {
          success: true,
          content: "📝 No recent summaries available for this chat pod.",
        };
      }

      // Format the summary for Discord
      const formattedSummary = this.formatSummaryForDiscord(latestSummary);

      return {
        success: true,
        content: formattedSummary,
      };
    } catch (error) {
      console.error("Error handling summary command:", error);
      return {
        success: false,
        content: "❌ An error occurred while fetching the summary.",
      };
    }
  }

  /**
   * Handle /commonly-summary command with deferred response
   * For long-running operations that might exceed 3 seconds
   */
  async handleSummaryCommandWithDefer(interactionToken) {
    try {
      // First, defer the response to show loading state
      const discordService = new DiscordService(this.integration._id);
      await discordService.deferResponse(interactionToken, false);

      // Perform the actual work
      const result = await this.handleSummaryCommand();

      // Send followup message with the result
      await discordService.sendFollowupMessage(
        interactionToken,
        result.content,
      );

      return result;
    } catch (error) {
      console.error("Error handling summary command with defer:", error);

      // Send error as followup
      const discordService = new DiscordService(this.integration._id);
      await discordService.sendFollowupMessage(
        interactionToken,
        "❌ An error occurred while fetching the summary.",
        { ephemeral: true },
      );

      return {
        success: false,
        content: "❌ An error occurred while fetching the summary.",
      };
    }
  }

  /**
   * Handle /discord-status command
   * Shows the status of Discord integration
   */
  async handleStatusCommand() {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: "❌ Discord integration not found.",
        };
      }

      // Populate pod information
      await this.integration.populate("podId", "name type");

      const { status } = this.integration;
      const podName = this.integration.podId?.name || "Unknown Pod";
      const podType = this.integration.podId?.type || "unknown";
      const serverName = this.integration.config.serverName || "Unknown Server";
      const channelName =
        this.integration.config.channelName || "Unknown Channel";
      const syncEnabled = this.integration.config.webhookListenerEnabled
        ? "✅ Enabled"
        : "❌ Disabled";

      const statusMessage = `🤖 **Discord Integration Status**

📊 **Status:** ${this.getStatusEmoji(status)} ${status}
🎯 **Commonly Pod:** ${podName} (${podType})
🏠 **Server:** ${serverName}
📺 **Channel:** ${channelName}
🔗 **Auto Sync:** ${syncEnabled}
⏰ **Last Sync:** ${this.integration.lastSync ? new Date(this.integration.lastSync).toLocaleString() : "Never"}`;

      return {
        success: true,
        content: statusMessage,
      };
    } catch (error) {
      console.error("Error handling status command:", error);
      return {
        success: false,
        content: "❌ An error occurred while fetching the status.",
      };
    }
  }

  /**
   * Handle /discord-enable command
   * Enables automatic Discord sync for this channel
   * When enabled: Discord messages → fetched hourly → sent as updates to Commonly pod
   */
  async handleEnableCommand() {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: "❌ Discord integration not found.",
        };
      }

      // Update integration to enable webhook listener
      await Integration.findByIdAndUpdate(this.integration._id, {
        "config.webhookListenerEnabled": true,
      });

      return {
        success: true,
        content:
          "✅ Auto sync enabled! Discord channel activity will now be fetched and summarized hourly, then posted to your Commonly pod by @commonly-bot.",
      };
    } catch (error) {
      console.error("Error handling enable command:", error);
      return {
        success: false,
        content: "❌ An error occurred while enabling the webhook listener.",
      };
    }
  }

  /**
   * Handle /discord-disable command
   * Disables webhook listener for this Discord channel
   * When disabled: Discord messages are no longer aggregated or sent to Commonly
   */
  async handleDisableCommand() {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: "❌ Discord integration not found.",
        };
      }

      // Update integration to disable webhook listener
      await Integration.findByIdAndUpdate(this.integration._id, {
        "config.webhookListenerEnabled": false,
      });

      return {
        success: true,
        content:
          "🔕 Auto sync disabled. Discord channel activity will no longer be fetched or posted to your Commonly pod.",
      };
    } catch (error) {
      console.error("Error handling disable command:", error);
      return {
        success: false,
        content: "❌ An error occurred while disabling the webhook listener.",
      };
    }
  }

  /**
   * Handle /discord-push command
   * Immediately aggregates Discord activity from last hour and posts to Commonly pod
   */
  async handlePushCommand(discordServiceInstance = null) {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: "❌ Discord integration not found.",
        };
      }

      // Check if webhook listener is enabled
      if (!this.integration.config.webhookListenerEnabled) {
        return {
          success: false,
          content:
            "⚠️ Auto sync is disabled. Use `/discord-enable` first to enable Discord activity sync.",
        };
      }

      // Use the unified Discord sync method
      const syncResult = await discordServiceInstance.syncRecentMessages(1); // 1 hour

      // Format the response for Discord command
      if (syncResult.success && syncResult.messageCount > 0) {
        return {
          success: true,
          content: `✅ ${syncResult.content} Check your pod for the update from @commonly-bot.`,
        };
      } else if (syncResult.success && syncResult.messageCount === 0) {
        return {
          success: true,
          content: `📭 ${syncResult.content}`,
        };
      } else {
        return {
          success: false,
          content: `❌ ${syncResult.content}`,
        };
      }
    } catch (error) {
      console.error("Error handling push command:", error);
      return {
        success: false,
        content: "❌ An error occurred while pushing Discord activity.",
      };
    }
  }

  /**
   * Create a summary from Discord messages
   */
  async createDiscordSummary(messages, startTime, endTime) {
    // AI-powered summarization for meaningful Discord activity summaries
    // Since author is a string, we can't check .bot property
    // For now, include all messages (bot detection may need different approach)
    const userMessages = messages.filter((msg) => msg.author && msg.content);
    const uniqueUsers = [...new Set(userMessages.map((msg) => msg.author))];

    let content;
    if (userMessages.length === 0) {
      content =
        "Recent Discord activity consisted mainly of bot messages and system notifications.";
    } else if (userMessages.length <= 2) {
      // For very few messages, show them directly
      content = userMessages
        .map((msg) => `${msg.author}: ${msg.content}`)
        .join("\n");
    } else {
      // Use AI summarization for meaningful content
      try {
        const messageContent = userMessages
          .map((msg) => `${msg.author}: ${msg.content}`)
          .join("\n");

        content = await summarizerService.generateSummary(
          messageContent,
          "discord",
        );
      } catch (error) {
        console.error(
          "Failed to generate AI summary for Discord messages:",
          error,
        );
        // Fallback to simple summary
        const topUsers = uniqueUsers.slice(0, 3);
        content = `Active discussion with ${uniqueUsers.length} participants (${topUsers.join(", ")}${uniqueUsers.length > 3 ? " and others" : ""}).`;
      }
    }

    return {
      content: content,
      messageCount: messages.length,
      timeRange: {
        start: startTime,
        end: endTime,
      },
      serverName: this.integration?.config?.serverName || "Discord Server",
      channelName: this.integration?.config?.channelName || "general",
      serverId: this.integration?.config?.serverId || null,
      channelId: this.integration?.config?.channelId || null,
      summaryType: "manual",
    };
  }

  /**
   * Extract topics from messages (simple keyword extraction)
   */
  extractTopics(messages) {
    const text = messages
      .map((msg) => msg.content)
      .join(" ")
      .toLowerCase();
    const commonWords = [
      "the",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "can",
      "may",
      "might",
      "must",
      "shall",
      "a",
      "an",
      "this",
      "that",
      "these",
      "those",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "me",
      "him",
      "her",
      "us",
      "them",
    ];

    const words = text.match(/\b\w+\b/g) || [];
    const wordCount = {};

    words.forEach((word) => {
      if (word.length > 3 && !commonWords.includes(word)) {
        wordCount[word] = (wordCount[word] || 0) + 1;
      }
    });

    return Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([word]) => word);
  }

  /**
   * Format summary for Discord display
   */
  formatSummaryForDiscord(summary) {
    const formatDiscordTimestamp = (value) => {
      if (!value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
    };

    // Handle both DiscordSummaryHistory and Summary schemas
    const startTag = formatDiscordTimestamp(summary.timeRange?.start);
    const endTag = formatDiscordTimestamp(summary.timeRange?.end);
    const timeRange = startTag && endTag
      ? `${startTag} – ${endTag}`
      : "Recent activity";

    const messageCount =
      summary.messageCount || summary.metadata?.totalItems || "Unknown";
    const summaryType = summary.summaryType || summary.type || "chat";
    const title = summary.title || "Chat Summary";

    return `📊 **${title}**

⏰ **Time Period:** ${timeRange}
💬 **Messages Analyzed:** ${messageCount}
📝 **Summary Type:** ${summaryType}

${summary.content}

---
*Generated by Commonly AI*`;
  }

  /**
   * Get status emoji for Discord display
   */
  getStatusEmoji(status) {
    switch (status) {
      case "connected":
        return "🟢";
      case "disconnected":
        return "🔴";
      case "error":
        return "🟡";
      case "pending":
        return "🟠";
      default:
        return "⚪";
    }
  }
}

module.exports = DiscordCommandService;
