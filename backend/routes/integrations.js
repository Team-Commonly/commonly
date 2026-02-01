const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const router = express.Router();
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const Integration = require('../models/Integration');
const DiscordIntegration = require('../models/DiscordIntegration');
const DiscordService = require('../services/discordService');
const Pod = require('../models/Pod');
const User = require('../models/User');
const { buildCatalogEntries } = require('../integrations/catalog');
const { manifests } = require('../integrations/manifests');
const registry = require('../integrations');
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');
const { hash, randomSecret } = require('../utils/secret');

let validateRequiredConfig;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ validateRequiredConfig } = require('../../packages/integration-sdk/src/manifest'));
} catch (err) {
  validateRequiredConfig = (config, manifest) => {
    const required = manifest?.requiredConfig || [];
    const missing = required.filter((field) => {
      const value = config?.[field];
      return value === undefined || value === null || value === '';
    });
    if (missing.length) {
      const error = new Error(`Missing fields: ${missing.join(', ')}`);
      error.missing = missing;
      throw error;
    }
  };
}

const resolveEffectiveConfig = (type, config = {}) => {
  if (type !== 'discord') {
    return config;
  }
  return {
    ...config,
    botToken: config.botToken || process.env.DISCORD_BOT_TOKEN,
  };
};

const getMissingRequiredFields = (type, config) => {
  const manifest = manifests[type];
  if (!manifest?.requiredConfig?.length) return [];
  const effectiveConfig = resolveEffectiveConfig(type, config);
  return manifest.requiredConfig.filter((field) => {
    const value = effectiveConfig?.[field];
    return value === undefined || value === null || value === '';
  });
};

const isManifestComplete = (type, config) => getMissingRequiredFields(type, config).length === 0;

const validateManifestIfComplete = (type, config) => {
  const manifest = manifests[type];
  if (!manifest) return;
  if (!isManifestComplete(type, config)) return;
  const effectiveConfig = resolveEffectiveConfig(type, config);
  validateRequiredConfig(effectiveConfig, manifest);
};

async function canDeleteIntegration(integration, userId) {
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
}

const extractToken = (req) => {
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }
  return req.header('x-commonly-integration-token');
};

const ingestAuth = async (req, res, next) => {
  const token = extractToken(req);
  if (token && token.startsWith('cm_int_')) {
    const tokenHash = hash(token);
    const integration = await Integration.findOne({
      'ingestTokens.tokenHash': tokenHash,
    });

    if (!integration) {
      return res.status(401).json({ message: 'Invalid integration token' });
    }

    try {
      await Integration.updateOne(
        { _id: integration._id, 'ingestTokens.tokenHash': tokenHash },
        { $set: { 'ingestTokens.$.lastUsedAt': new Date() } },
      );
    } catch (err) {
      console.warn('Failed to update integration token usage:', err.message);
    }

    req.integrationAuth = true;
    req.integration = integration;
    return next();
  }

  return auth(req, res, next);
};

// Integration catalog metadata (manifest-driven)
router.get('/catalog', auth, async (req, res) => {
  try {
    const entries = await buildCatalogEntries({ userId: req.user?.id });
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching integration catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Ingest events from external provider services
router.post('/ingest', ingestAuth, async (req, res) => {
  try {
    const {
      provider,
      integrationId,
      event,
      messages,
    } = req.body || {};

    const { integration: tokenIntegration } = req;
    let integration = tokenIntegration;
    if (!integrationId && !integration) {
      return res.status(400).json({ message: 'integrationId is required' });
    }

    if (!integration) {
      integration = await Integration.findById(integrationId).lean();
    }

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    if (integrationId && integration._id.toString() !== integrationId.toString()) {
      return res.status(400).json({ message: 'integrationId does not match token' });
    }

    const providerName = provider || integration.type;
    if (providerName !== integration.type) {
      return res.status(400).json({ message: 'Provider does not match integration type' });
    }

    let normalizedMessages = [];
    if (Array.isArray(messages) && messages.length > 0) {
      normalizedMessages = messages;
    } else if (event) {
      let providerInstance;
      try {
        providerInstance = registry.get(providerName, integration);
      } catch (err) {
        return res.status(400).json({ message: 'Provider not registered' });
      }
      normalizedMessages = await providerInstance.ingestEvent(event);
    } else {
      return res.status(400).json({ message: 'event or messages is required' });
    }

    const bufferMessages = (normalizedMessages || [])
      .map(normalizeBufferMessage)
      .filter(Boolean);

    if (bufferMessages.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    const maxBufferSize = integration.config?.maxBufferSize || 1000;

    await Integration.findByIdAndUpdate(integration._id, {
      $push: {
        'config.messageBuffer': {
          $each: bufferMessages,
          $slice: -1 * maxBufferSize,
        },
      },
    });

    res.json({ success: true, count: bufferMessages.length });
  } catch (error) {
    console.error('Error ingesting integration event:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Issue a new ingest token for external services
router.post('/:id/ingest-tokens', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { label } = req.body || {};
    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    const canUpdate = await canDeleteIntegration(integration, req.user.id);
    if (!canUpdate) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const token = `cm_int_${randomSecret(16)}`;
    const tokenHash = hash(token);

    integration.ingestTokens = integration.ingestTokens || [];
    integration.ingestTokens.push({
      tokenHash,
      label: label || '',
      createdBy: req.user.id,
      createdAt: new Date(),
    });

    await integration.save();

    res.json({ token });
  } catch (error) {
    console.error('Error issuing ingest token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// List ingest tokens (metadata only)
router.get('/:id/ingest-tokens', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    const canUpdate = await canDeleteIntegration(integration, req.user.id);
    if (!canUpdate) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const tokens = (integration.ingestTokens || []).map((token) => ({
      id: token._id.toString(),
      label: token.label,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      createdBy: token.createdBy,
    }));

    res.json({ tokens });
  } catch (error) {
    console.error('Error listing ingest tokens:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Revoke ingest token
router.delete('/:id/ingest-tokens/:tokenId', auth, async (req, res) => {
  try {
    const { id, tokenId } = req.params;
    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    const canUpdate = await canDeleteIntegration(integration, req.user.id);
    if (!canUpdate) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const before = integration.ingestTokens?.length || 0;
    integration.ingestTokens = (integration.ingestTokens || []).filter(
      (token) => token._id.toString() !== tokenId,
    );

    if ((integration.ingestTokens || []).length === before) {
      return res.status(404).json({ message: 'Token not found' });
    }

    await integration.save();
    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking ingest token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

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

    const manifest = manifests[type];
    if (!manifest) {
      return res.status(400).json({ message: 'Unsupported integration type' });
    }

    // Create base integration
    const nextConfig = { ...config };

    if (type === 'telegram' && !nextConfig.connectCode) {
      nextConfig.connectCode = crypto.randomBytes(3).toString('hex');
    }

    const missingRequired = getMissingRequiredFields(type, nextConfig);
    if (type === 'discord' && missingRequired.length) {
      return res.status(400).json({
        message: `Missing required fields: ${missingRequired.join(', ')}`,
        missing: missingRequired,
      });
    }
    if (missingRequired.length && req.body.status === 'connected') {
      return res.status(400).json({
        message: `Missing required fields: ${missingRequired.join(', ')}`,
        missing: missingRequired,
      });
    }
    validateManifestIfComplete(type, nextConfig);

    const integration = new Integration({
      podId,
      type,
      config: nextConfig,
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
    } else if (['slack', 'groupme', 'telegram', 'messenger', 'whatsapp', 'x', 'instagram'].includes(type)) {
      // No platform-specific record required; mark as connected only when manifest is complete
      integration.status = isManifestComplete(type, nextConfig) ? 'connected' : 'pending';
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

// Update integration config/status
router.patch('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { config, status, isActive } = req.body || {};

    const integration = await Integration.findById(id);
    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    const canUpdate = await canDeleteIntegration(integration, req.user.id);
    if (!canUpdate) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const currentConfig = integration.config?.toObject
      ? integration.config.toObject()
      : integration.config || {};
    const nextConfig = config ? { ...currentConfig, ...config } : currentConfig;

    const missingRequired = getMissingRequiredFields(integration.type, nextConfig);
    if (missingRequired.length && status === 'connected') {
      return res.status(400).json({
        message: `Missing required fields: ${missingRequired.join(', ')}`,
        missing: missingRequired,
      });
    }
    validateManifestIfComplete(integration.type, nextConfig);

    const update = {};
    if (config) {
      update.config = nextConfig;
    }
    if (typeof status === 'string') {
      update.status = status;
    }
    if (typeof isActive === 'boolean') {
      update.isActive = isActive;
    }

    if (integration.type === 'groupme' && config) {
      update.status = update.status || (isManifestComplete(integration.type, nextConfig) ? 'connected' : 'pending');
    }

    if (integration.type === 'telegram' && config) {
      update.status = update.status || (isManifestComplete(integration.type, nextConfig) ? 'connected' : 'pending');
    }

    if (integration.type === 'slack' && config) {
      update.status = update.status || (isManifestComplete(integration.type, nextConfig) ? 'connected' : 'pending');
    }

    if (['x', 'instagram'].includes(integration.type) && config) {
      update.status = update.status || (isManifestComplete(integration.type, nextConfig) ? 'connected' : 'pending');
    }

    const updated = await Integration.findByIdAndUpdate(id, update, {
      new: true,
    });

    return res.json(updated);
  } catch (error) {
    console.error('Error updating integration:', error);
    return res.status(500).json({ message: 'Server error' });
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

    // Check if user can delete this integration
    const canDelete = await canDeleteIntegration(integration, req.user.id);
    if (!canDelete) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Disconnect first (only Discord has a disconnect step)
    const service = integration.type === 'discord' ? new DiscordService(id) : null;

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
