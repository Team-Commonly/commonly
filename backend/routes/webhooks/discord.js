const express = require('express');

const router = express.Router();
const DiscordService = require('../../services/discordService');
const DiscordIntegration = require('../../models/DiscordIntegration');

// Discord webhook endpoint
router.post('/', async (req, res) => {
  try {
    const event = req.body;

    // Handle Discord webhook verification
    if (event.type === 1) { // PING
      return res.json({ type: 1 }); // PONG
    }

    // Extract webhook ID from the request
    const webhookId = req.query.webhook_id || req.headers['x-discord-webhook-id'];

    if (!webhookId) {
      console.error('No webhook ID provided');
      return res.status(400).json({ error: 'Missing webhook ID' });
    }

    // Find the Discord integration by webhook ID
    const discordIntegration = await DiscordIntegration.findOne({
      webhookId,
      isActive: true,
    });

    if (!discordIntegration) {
      console.error('Discord integration not found for webhook ID:', webhookId);
      return res.status(404).json({ error: 'Integration not found' });
    }

    // Create Discord service instance
    const service = new DiscordService(discordIntegration.integrationId);

    // Handle the webhook event
    await service.handleWebhook(event);

    res.json({ success: true });
  } catch (error) {
    console.error('Error handling Discord webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Discord-specific routes
router.get('/channels/:integrationId', async (req, res) => {
  try {
    const { integrationId } = req.params;

    const service = new DiscordService(integrationId);
    const channels = await service.getChannels();

    res.json(channels);
  } catch (error) {
    console.error('Error fetching Discord channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Generate bot invite link
router.post('/invite', async (req, res) => {
  try {
    const { clientId, permissions, guildId } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: 'Client ID is required' });
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
    res.status(500).json({ error: 'Failed to generate invite link' });
  }
});

// Test webhook endpoint
router.post('/test/:integrationId', async (req, res) => {
  try {
    const { integrationId } = req.params;

    const service = new DiscordService(integrationId);
    const isConnected = await service.testConnection();

    if (isConnected) {
      res.json({ success: true, message: 'Webhook connection test successful' });
    } else {
      res.status(400).json({ success: false, message: 'Webhook connection test failed' });
    }
  } catch (error) {
    console.error('Error testing webhook:', error);
    res.status(500).json({ error: 'Failed to test webhook' });
  }
});

module.exports = router;
