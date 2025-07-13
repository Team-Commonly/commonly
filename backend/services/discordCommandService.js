const Integration = require('../models/Integration');
const DiscordSummaryHistory = require('../models/DiscordSummaryHistory');
const DiscordService = require('./discordService');

/**
 * Discord Command Service
 * Handles Discord bot commands and interactions
 */
class DiscordCommandService {
  constructor(guildId) {
    this.guildId = guildId; // Use guild ID as installation identifier
    this.integration = null;
  }

  /**
   * Initialize the service with integration data
   */
  async initialize() {
    try {
      // Find integration by guild ID (server ID)
      this.integration = await Integration.findOne({
        $or: [
          { 'platformIntegration.serverId': this.guildId },
          { 'config.serverId': this.guildId },
        ],
        type: 'discord',
        isActive: true,
      });

      if (!this.integration) {
        throw new Error(`Integration not found for guild ID: ${this.guildId}`);
      }
      return true;
    } catch (error) {
      console.error('Error initializing Discord command service:', error);
      return false;
    }
  }

  /**
   * Handle /commonly-summary command
   * Fetches the most recent hourly summary from the linked chat pod
   */
  async handleSummaryCommand() {
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

      // Get the most recent summary for this integration
      const latestSummary = await DiscordSummaryHistory.findOne({
        integrationId: this.integration._id,
      }).sort({ createdAt: -1 });

      if (!latestSummary) {
        return {
          success: true,
          content: '📝 No recent summaries available for this chat pod.',
        };
      }

      // Format the summary for Discord
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
      await discordService.sendFollowupMessage(interactionToken, result.content);

      return result;
    } catch (error) {
      console.error('Error handling summary command with defer:', error);

      // Send error as followup
      const discordService = new DiscordService(this.integration._id);
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
          content: '❌ Discord integration not found.',
        };
      }

      const { status } = this.integration;
      const serverName = this.integration.config.serverName || 'Unknown Server';
      const channelName = this.integration.config.channelName || 'Unknown Channel';
      const webhookEnabled = this.integration.config.webhookListenerEnabled ? '✅ Enabled' : '❌ Disabled';

      const statusMessage = `🤖 **Discord Integration Status**

📊 **Status:** ${this.getStatusEmoji(status)} ${status}
🏠 **Server:** ${serverName}
📺 **Channel:** ${channelName}
🔗 **Webhook Listener:** ${webhookEnabled}
⏰ **Last Sync:** ${this.integration.lastSync ? new Date(this.integration.lastSync).toLocaleString() : 'Never'}`;

      return {
        success: true,
        content: statusMessage,
      };
    } catch (error) {
      console.error('Error handling status command:', error);
      return {
        success: false,
        content: '❌ An error occurred while fetching the status.',
      };
    }
  }

  /**
   * Handle /discord-enable command
   * Enables webhook listener for the Discord channel
   */
  async handleEnableCommand() {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: '❌ Discord integration not found.',
        };
      }

      // Update integration to enable webhook listener
      await Integration.findByIdAndUpdate(this.integration._id, {
        'config.webhookListenerEnabled': true,
      });

      return {
        success: true,
        content: '✅ Webhook listener enabled! Discord channel activity will now be summarized and sent to the chat pod.',
      };
    } catch (error) {
      console.error('Error handling enable command:', error);
      return {
        success: false,
        content: '❌ An error occurred while enabling the webhook listener.',
      };
    }
  }

  /**
   * Handle /discord-disable command
   * Disables webhook listener for the Discord channel
   */
  async handleDisableCommand() {
    try {
      if (!this.integration) {
        await this.initialize();
      }

      if (!this.integration) {
        return {
          success: false,
          content: '❌ Discord integration not found.',
        };
      }

      // Update integration to disable webhook listener
      await Integration.findByIdAndUpdate(this.integration._id, {
        'config.webhookListenerEnabled': false,
      });

      return {
        success: true,
        content: '❌ Webhook listener disabled. Discord channel activity will no longer be summarized.',
      };
    } catch (error) {
      console.error('Error handling disable command:', error);
      return {
        success: false,
        content: '❌ An error occurred while disabling the webhook listener.',
      };
    }
  }

  /**
   * Format summary for Discord display
   */
  formatSummaryForDiscord(summary) {
    const timeRange = `${new Date(summary.timeRange.start).toLocaleString()} - ${new Date(summary.timeRange.end).toLocaleString()}`;

    return `📊 **Chat Pod Summary**

⏰ **Time Period:** ${timeRange}
💬 **Messages Analyzed:** ${summary.messageCount}
📝 **Summary Type:** ${summary.summaryType}

${summary.content}

---
*Generated by Commonly AI*`;
  }

  /**
   * Get status emoji for Discord display
   */
  getStatusEmoji(status) {
    switch (status) {
      case 'connected':
        return '🟢';
      case 'disconnected':
        return '🔴';
      case 'error':
        return '🟡';
      case 'pending':
        return '🟠';
      default:
        return '⚪';
    }
  }
}

module.exports = DiscordCommandService;
