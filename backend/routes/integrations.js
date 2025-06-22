const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const Integration = require('../models/Integration');
const DiscordIntegration = require('../models/DiscordIntegration');
const DiscordService = require('../services/discordService');
const Pod = require('../models/Pod');

// Get all integrations for a pod
router.get('/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    const integrations = await Integration.find({
      podId,
      isActive: true,
    }).populate('platformIntegration');

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
    let platformIntegration;

    switch (type) {
      case 'discord':
        platformIntegration = new DiscordIntegration({
          integrationId: integration._id,
          serverId: config.serverId,
          serverName: config.serverName,
          channelId: config.channelId,
          channelName: config.channelName,
          webhookUrl: config.webhookUrl,
          webhookId: config.webhookId,
          botToken: config.botToken,
          permissions: config.permissions || ['read_messages', 'send_messages'],
        });
        break;

      default:
        return res.status(400).json({ message: 'Unsupported integration type' });
    }

    await platformIntegration.save();

    // Initialize the integration service
    const service = new DiscordService(integration._id);
    const initialized = await service.initialize();

    if (!initialized) {
      return res.status(500).json({ message: 'Failed to initialize integration' });
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
      default:
        return res.status(400).json({ message: 'Unsupported integration type' });
    }

    const connected = await service.connect();

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
        return res.status(400).json({ message: 'Unsupported integration type' });
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
      default:
        return res.status(400).json({ message: 'Unsupported integration type' });
    }

    const stats = await service.getStats();
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
      default:
        return res.status(400).json({ message: 'Unsupported integration type' });
    }

    const messages = await service.fetchMessages({ limit, before });
    res.json(messages);
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
      default:
        return res.status(400).json({ message: 'Unsupported integration type' });
    }

    const result = await service.sendMessage(message);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error sending message through integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete an integration
router.delete('/:id', auth, async (req, res) => {
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

    // Disconnect first
    let service;
    switch (integration.type) {
      case 'discord':
        service = new DiscordService(id);
        break;
      default:
        return res.status(400).json({ message: 'Unsupported integration type' });
    }

    await service.disconnect();

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
