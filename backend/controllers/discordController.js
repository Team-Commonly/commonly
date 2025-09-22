const DiscordService = require('../services/discordService');
const DiscordIntegration = require('../models/DiscordIntegration');
const Integration = require('../models/Integration');

/**
 * Discord Integration Controller
 * Handles Discord-specific operations and bot management
 */
class DiscordController {
  /**
   * Create a new Discord integration
   */
  static async createIntegration(req, res) {
    try {
      const {
        podId,
        serverId,
        serverName,
        channelId,
        channelName,
        webhookUrl,
        botToken,
      } = req.body;

      // Validate required fields
      if (!podId || !serverId || !channelId || !webhookUrl || !botToken) {
        return res.status(400).json({
          message:
            'Missing required fields: podId, serverId, channelId, webhookUrl, botToken',
        });
      }

      // Extract webhook ID from URL
      const webhookId = webhookUrl.split('/').pop();

      // Create base integration
      const integration = new Integration({
        podId,
        type: 'discord',
        config: {
          serverId,
          serverName,
          channelId,
          channelName,
          webhookUrl,
          webhookId,
          botToken,
        },
        createdBy: req.user.id,
        status: 'pending',
      });

      await integration.save();

      // Create Discord-specific integration
      const discordIntegration = new DiscordIntegration({
        integrationId: integration._id,
        serverId,
        serverName: serverName || 'Unknown Server',
        channelId,
        channelName: channelName || 'Unknown Channel',
        webhookUrl,
        webhookId,
        botToken,
        permissions: ['read_messages', 'send_messages', 'read_message_history'],
      });

      await discordIntegration.save();

      // Initialize and test the integration
      const service = new DiscordService(integration._id);
      const initialized = await service.initialize();

      if (!initialized) {
        // Clean up if initialization fails
        await Integration.findByIdAndDelete(integration._id);
        await DiscordIntegration.findOneAndDelete({
          integrationId: integration._id,
        });
        return res
          .status(500)
          .json({ message: 'Failed to initialize Discord integration' });
      }

      // Test connection
      const isConnected = await service.connect();

      res.status(201).json({
        integration,
        discordIntegration,
        connected: isConnected,
      });
    } catch (error) {
      console.error('Error creating Discord integration:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  /**
   * Get Discord integration details
   */
  static async getIntegration(req, res) {
    try {
      const { id } = req.params;

      const integration = await Integration.findById(id);
      if (!integration) {
        return res.status(404).json({ message: 'Integration not found' });
      }

      const discordIntegration = await DiscordIntegration.findOne({
        integrationId: id,
      });
      if (!discordIntegration) {
        return res
          .status(404)
          .json({ message: 'Discord integration not found' });
      }

      res.json({
        integration,
        discordIntegration,
      });
    } catch (error) {
      console.error('Error fetching Discord integration:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  /**
   * Update Discord integration
   */
  static async updateIntegration(req, res) {
    try {
      const { id } = req.params;
      const { serverName, channelName, webhookUrl, botToken } = req.body;

      const integration = await Integration.findById(id);
      if (!integration) {
        return res.status(404).json({ message: 'Integration not found' });
      }

      const discordIntegration = await DiscordIntegration.findOne({
        integrationId: id,
      });
      if (!discordIntegration) {
        return res
          .status(404)
          .json({ message: 'Discord integration not found' });
      }

      // Update fields if provided
      if (serverName) discordIntegration.serverName = serverName;
      if (channelName) discordIntegration.channelName = channelName;
      if (webhookUrl) {
        discordIntegration.webhookUrl = webhookUrl;
        discordIntegration.webhookId = webhookUrl.split('/').pop();
      }
      if (botToken) discordIntegration.botToken = botToken;

      await discordIntegration.save();

      // Update base integration config
      integration.config = {
        ...integration.config,
        serverName: discordIntegration.serverName,
        channelName: discordIntegration.channelName,
        webhookUrl: discordIntegration.webhookUrl,
        webhookId: discordIntegration.webhookId,
        botToken: discordIntegration.botToken,
      };

      await integration.save();

      // Test the updated connection
      const service = new DiscordService(id);
      const isConnected = await service.connect();

      res.json({
        integration,
        discordIntegration,
        connected: isConnected,
      });
    } catch (error) {
      console.error('Error updating Discord integration:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  /**
   * Get Discord channels for a server
   */
  static async getChannels(req, res) {
    try {
      const { integrationId } = req.params;

      const service = new DiscordService(integrationId);
      const channels = await service.getChannels();

      res.json(channels);
    } catch (error) {
      console.error('Error fetching Discord channels:', error);
      res.status(500).json({ message: 'Failed to fetch channels' });
    }
  }

  /**
   * Generate bot invite link
   */
  static async generateInviteLink(req, res) {
    try {
      const { clientId, permissions, guildId } = req.body;

      if (!clientId) {
        return res.status(400).json({ message: 'Client ID is required' });
      }

      const baseUrl = 'https://discord.com/api/oauth2/authorize';
      const scopes = ['bot', 'applications.commands'];
      const botPermissions = permissions || '2048'; // Read Messages, Send Messages

      const inviteUrl = `${baseUrl}?client_id=${clientId}&scope=${scopes.join('%20')}&permissions=${botPermissions}${
        guildId ? `&guild_id=${guildId}` : ''
      }`;

      res.json({ inviteUrl });
    } catch (error) {
      console.error('Error generating invite link:', error);
      res.status(500).json({ message: 'Failed to generate invite link' });
    }
  }

  /**
   * Test Discord webhook connection
   */
  static async testWebhook(req, res) {
    try {
      const { webhookUrl } = req.body;

      if (!webhookUrl) {
        return res.status(400).json({ message: 'Webhook URL is required' });
      }

      // Basic validation
      if (!webhookUrl.includes('discord.com/api/webhooks/')) {
        return res
          .status(400)
          .json({ message: 'Invalid Discord webhook URL format' });
      }

      // Try to send a test message
      const testMessage = {
        content: '🤖 Discord integration test message from Commonly',
        username: 'Commonly Bot',
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testMessage),
      });

      if (response.ok) {
        res.json({
          success: true,
          message: 'Webhook test successful',
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Webhook test failed',
          status: response.status,
        });
      }
    } catch (error) {
      console.error('Error testing webhook:', error);
      res.status(500).json({ message: 'Failed to test webhook' });
    }
  }

  /**
   * Get Discord integration statistics
   */
  static async getStats(req, res) {
    try {
      const { id } = req.params;

      const service = new DiscordService(id);
      const stats = await service.getStats();

      res.json(stats);
    } catch (error) {
      console.error('Error getting Discord stats:', error);
      res.status(500).json({ message: 'Failed to get statistics' });
    }
  }
}

module.exports = DiscordController;
