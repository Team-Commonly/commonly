const express = require('express');
const axios = require('axios');

const router = express.Router();
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const Integration = require('../models/Integration');
const DiscordIntegration = require('../models/DiscordIntegration');
const DiscordService = require('../services/discordService');
const Pod = require('../models/Pod');
const User = require('../models/User');

// Get all integrations for a pod
router.get('/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    const integrations = await Integration.find({
      podId,
      isActive: true,
    })
      .populate('createdBy', 'username email')
      .populate('platformIntegration');

    res.json(integrations);
  } catch (error) {
    console.error('Error fetching integrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new integration
router.post('/', auth, async (req, res) => {
  try {
    const { podId, type, config } = req.body;

    // Validate request
    if (!podId || !type || !config) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Create base integration
    const integration = new Integration({
      podId,
      type,
      config,
      createdBy: req.user.id,
      status: 'pending',
    });

    await integration.save();

    // Create platform-specific integration
    let platformIntegration = null;

    if (type === 'discord') {
      // Create Discord webhook automatically
      const webhookResponse = await axios.post(
        `https://discord.com/api/channels/${config.channelId}/webhooks`,
        {
          name: 'Commonly Bot',
          avatar: null, // Could add a bot avatar URL here
        },
        {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const webhook = webhookResponse.data;

      platformIntegration = new DiscordIntegration({
        integrationId: integration._id,
        serverId: config.serverId,
        serverName: config.serverName,
        channelId: config.channelId,
        channelName: config.channelName,
        webhookUrl: `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`,
        webhookId: webhook.id,
        botToken: process.env.DISCORD_BOT_TOKEN,
        permissions: config.permissions || ['read_messages', 'send_messages'],
      });
      await platformIntegration.save();
    } else if (['slack', 'groupme', 'telegram', 'messenger', 'whatsapp'].includes(type)) {
      // No platform-specific record required; mark as connected immediately
      integration.status = 'connected';
      await integration.save();
    } else {
      return res.status(400).json({ message: 'Unsupported integration type' });
    }

    // Initialize the integration service for Discord only
    if (type === 'discord') {
      const service = new DiscordService(integration._id);
      const initialized = await service.initialize();

      if (!initialized) {
        return res
          .status(500)
          .json({ message: 'Failed to initialize integration' });
      }

      // Connect the integration to update status from pending to connected
      const connected = await service.connect();

      if (!connected) {
        console.warn('Integration initialized but failed to connect');
      }
    }

    res.status(201).json({
      integration,
      platformIntegration,
    });
  } catch (error) {
    console.error('Error creating integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Connect an integration
router.post('/:id/connect', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Check if user owns the pod
    const pod = await Pod.findById(integration.podId);
    if (!pod || pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Connect based on type
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      case 'slack':
        service = null; // No remote connect step
        break;
      default:
        return res
          .status(400)
          .json({ message: 'Unsupported integration type' });
    }

    const connected = service ? await service.connect() : true;

    if (connected) {
      res.json({ message: 'Integration connected successfully' });
    } else {
      res.status(500).json({ message: 'Failed to connect integration' });
    }
  } catch (error) {
    console.error('Error connecting integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Disconnect an integration
router.post('/:id/disconnect', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Check if user owns the pod
    const pod = await Pod.findById(integration.podId);
    if (!pod || pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Disconnect based on type
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      default:
        return res
          .status(400)
          .json({ message: 'Unsupported integration type' });
    }

    const disconnected = await service.disconnect();

    if (disconnected) {
      res.json({ message: 'Integration disconnected successfully' });
    } else {
      res.status(500).json({ message: 'Failed to disconnect integration' });
    }
  } catch (error) {
    console.error('Error disconnecting integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get integration status and stats
router.get('/:id/stats', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Check if user owns the pod
    const pod = await Pod.findById(integration.podId);
    if (!pod || pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get stats based on type
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      case 'slack':
        service = null;
        break;
      default:
        return res
          .status(400)
          .json({ message: 'Unsupported integration type' });
    }

    const stats = service ? await service.getStats() : { connected: true };
    res.json(stats);
  } catch (error) {
    console.error('Error getting integration stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Fetch messages from integration
router.get('/:id/messages', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit, before } = req.query;

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Check if user owns the pod
    const pod = await Pod.findById(integration.podId);
    if (!pod || pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Fetch messages based on type
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      case 'slack':
        service = null;
        break;
      default:
        return res
          .status(400)
          .json({ message: 'Unsupported integration type' });
    }

    if (service) {
      const messages = await service.fetchMessages({ limit, before });
      return res.json(messages);
    }
    return res.json({ messages: [] });
  } catch (error) {
    console.error('Error fetching integration messages:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Send a message through integration
router.post('/:id/send', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message, _type } = req.body;

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Check if user owns the pod
    const pod = await Pod.findById(integration.podId);
    if (!pod || pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Send message based on type
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      case 'slack':
        service = null; // TODO: implement Slack send
        break;
      default:
        return res
          .status(400)
          .json({ message: 'Unsupported integration type' });
    }

    if (service) {
      const result = await service.sendMessage(message);
      return res.json({ success: true, result });
    }
    return res.json({ success: true, result: 'not-implemented' });
  } catch (error) {
    console.error('Error sending message through integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all integrations (admin only)
router.get('/admin/all', auth, adminAuth, async (req, res) => {
  try {
    const integrations = await Integration.find({ isActive: true })
      .populate('podId', 'name type createdBy')
      .populate('createdBy', 'username email')
      .populate('platformIntegration')
      .sort({ createdAt: -1 });

    res.json(integrations);
  } catch (error) {
    console.error('Error fetching all integrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user's integrations across all pods
router.get('/user/all', auth, async (req, res) => {
  try {
    const integrations = await Integration.find({
      createdBy: req.user.id,
      isActive: true,
    })
      .populate('podId', 'name type')
      .populate('platformIntegration')
      .sort({ createdAt: -1 });

    res.json(integrations);
  } catch (error) {
    console.error('Error fetching user integrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Check if user can delete integration
const canDeleteIntegration = async (integration, userId) => {
  const user = await User.findById(userId);

  // Admin can delete any integration
  if (user.role === 'admin') {
    return true;
  }

  // Pod owner can delete integrations in their pod
  const pod = await Pod.findById(integration.podId);
  if (pod && pod.createdBy.toString() === userId) {
    return true;
  }

  // Integration creator can delete their own integration
  if (integration.createdBy.toString() === userId) {
    return true;
  }

  return false;
};

// Delete an integration
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Check if user can delete this integration
    const canDelete = await canDeleteIntegration(integration, req.user.id);
    if (!canDelete) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Disconnect first
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      case 'slack':
        service = null;
        break;
      default:
        return res
          .status(400)
          .json({ message: 'Unsupported integration type' });
    }

    try {
      if (service) await service.disconnect();
    } catch (error) {
      console.warn('Error disconnecting service during deletion:', error);
      // Continue with deletion even if disconnect fails
    }

    // Delete platform-specific integration
    switch (integration.type) {
      case 'discord':
        await DiscordIntegration.findOneAndDelete({ integrationId: id });
        break;
      default:
        // No specific cleanup needed for unsupported types
        break;
    }

    // Delete base integration
    await Integration.findByIdAndDelete(id);

    res.json({ message: 'Integration deleted successfully' });
  } catch (error) {
    console.error('Error deleting integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
