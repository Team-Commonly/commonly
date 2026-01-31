const express = require('express');

const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const AgentEventService = require('../services/agentEventService');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentMessageService = require('../services/agentMessageService');
const PodContextService = require('../services/podContextService');
const User = require('../models/User');
const { AgentInstallation } = require('../models/AgentRegistry');
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');

const router = express.Router();

const ensurePodMatch = (installation, podId) => (
  installation?.podId?.toString() === podId.toString()
);

const requireBotUser = async (req, res) => {
  const userId = req.userId || req.user?.id;
  const user = await User.findById(userId).lean();
  if (!user || !user.isBot) {
    return { error: res.status(403).json({ message: 'This endpoint is for bot users only' }) };
  }
  return { user };
};

const ensureBotInstallation = async (agentName, podId, instanceId = 'default') => {
  const installation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    status: 'active',
  }).lean();
  return installation;
};

/**
 * GET /events (agent runtime token auth)
 * Original endpoint for agent runtime tokens (cm_agent_*)
 */
router.get('/events', agentRuntimeAuth, async (req, res) => {
  try {
    const installation = req.agentInstallation;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const events = await AgentEventService.list({
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
      podId: installation.podId,
      limit,
    });

    return res.json({ events });
  } catch (error) {
    console.error('Error listing agent events:', error);
    return res.status(500).json({ message: 'Failed to list agent events' });
  }
});

/**
 * GET /bot/events (user API token auth)
 * For bot users to poll events using their user API token
 * Bot user must have isBot: true and username matching agentName
 */
router.get('/bot/events', auth, requireApiTokenScopes(['agent:events:read']), async (req, res) => {
  try {
    const { user, error } = await requireBotUser(req, res);
    if (error) return error;

    const agentName = req.query.agentName || user.botMetadata?.agentName || null;
    const instanceId = req.query.instanceId || user.botMetadata?.instanceId || 'default';
    const resolvedAgentName = agentName || user.username;
    const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
    if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
      return res.status(403).json({ message: 'Agent token does not match bot user' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    // Find all pods where this agent is installed
    const installations = await AgentInstallation.find({
      agentName: resolvedAgentName.toLowerCase(),
      instanceId,
      status: 'active',
    }).lean();

    const podIds = installations.map((i) => i.podId);

    // List events across all installed pods
    const events = await AgentEventService.list({
      agentName: resolvedAgentName,
      instanceId,
      podIds,
      limit,
    });

    return res.json({ events });
  } catch (error) {
    console.error('Error listing bot events:', error);
    return res.status(500).json({ message: 'Failed to list bot events' });
  }
});

/**
 * POST /bot/events/:id/ack (user API token auth)
 * For bot users to acknowledge events
 */
router.post('/bot/events/:id/ack', auth, requireApiTokenScopes(['agent:events:ack']), async (req, res) => {
  try {
    const { user, error } = await requireBotUser(req, res);
    if (error) return error;

    const agentName = req.body.agentName || user.botMetadata?.agentName || null;
    const instanceId = req.body.instanceId || user.botMetadata?.instanceId || 'default';
    const resolvedAgentName = agentName || user.username;
    const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
    if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
      return res.status(403).json({ message: 'Agent token does not match bot user' });
    }
    await AgentEventService.acknowledge(req.params.id, resolvedAgentName, instanceId);

    return res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging bot event:', error);
    return res.status(500).json({ message: 'Failed to acknowledge bot event' });
  }
});

router.post('/events/:id/ack', agentRuntimeAuth, async (req, res) => {
  try {
    const installation = req.agentInstallation;
    await AgentEventService.acknowledge(
      req.params.id,
      installation.agentName,
      installation.instanceId || 'default',
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging agent event:', error);
    return res.status(500).json({ message: 'Failed to acknowledge agent event' });
  }
});

/**
 * GET /bot/pods/:podId/context (user API token auth)
 * Bot users can fetch pod context without runtime tokens.
 */
router.get(
  '/bot/pods/:podId/context',
  auth,
  requireApiTokenScopes(['agent:context:read']),
  async (req, res) => {
    try {
      const { podId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.query.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.query.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const installation = await ensureBotInstallation(resolvedAgentName, podId, instanceId);
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      await AgentIdentityService.ensureAgentInPod(user, podId);

      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const parseLimit = (raw, fallback, max) => {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isNaN(parsed)) return fallback;
        return clamp(parsed, 1, max);
      };

      const context = await PodContextService.getPodContext({
        podId,
        userId: user._id,
        task: req.query.task || '',
        summaryLimit: parseLimit(req.query.summaryLimit, 6, 20),
        assetLimit: parseLimit(req.query.assetLimit, 12, 40),
        tagLimit: parseLimit(req.query.tagLimit, 16, 40),
        skillLimit: parseLimit(req.query.skillLimit, 6, 12),
        skillMode: typeof req.query.skillMode === 'string' ? req.query.skillMode.toLowerCase() : 'llm',
        skillRefreshHours: parseLimit(req.query.skillRefreshHours, 6, 72),
      });

      return res.json(context);
    } catch (error) {
      console.error('Error fetching bot pod context:', error);
      return res.status(500).json({ message: 'Failed to fetch pod context' });
    }
  },
);

/**
 * GET /bot/pods/:podId/messages (user API token auth)
 */
router.get(
  '/bot/pods/:podId/messages',
  auth,
  requireApiTokenScopes(['agent:messages:read']),
  async (req, res) => {
    try {
      const { podId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.query.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.query.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const installation = await ensureBotInstallation(resolvedAgentName, podId, instanceId);
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const messages = await AgentMessageService.getRecentMessages(podId, limit);
      return res.json({ messages });
    } catch (error) {
      console.error('Error fetching bot messages:', error);
      return res.status(500).json({ message: 'Failed to fetch messages' });
    }
  },
);

/**
 * POST /bot/pods/:podId/messages (user API token auth)
 */
router.post(
  '/bot/pods/:podId/messages',
  auth,
  requireApiTokenScopes(['agent:messages:write']),
  async (req, res) => {
    try {
      const { podId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.body.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.body.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const installation = await ensureBotInstallation(resolvedAgentName, podId, instanceId);
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      const { content, metadata, messageType } = req.body || {};
      const result = await AgentMessageService.postMessage({
        agentName: resolvedAgentName,
        instanceId,
        displayName: installation.displayName,
        podId,
        content,
        metadata,
        messageType,
      });

      return res.json(result);
    } catch (error) {
      console.error('Error posting bot message:', error);
      return res.status(500).json({ message: error.message || 'Failed to post message' });
    }
  },
);

router.get('/pods/:podId/context', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = req.agentInstallation;

    if (!ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(installation.agentName, {
      instanceId: installation.instanceId || 'default',
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const parseLimit = (raw, fallback, max) => {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) return fallback;
      return clamp(parsed, 1, max);
    };

    const context = await PodContextService.getPodContext({
      podId,
      userId: agentUser._id,
      task: req.query.task || '',
      summaryLimit: parseLimit(req.query.summaryLimit, 6, 20),
      assetLimit: parseLimit(req.query.assetLimit, 12, 40),
      tagLimit: parseLimit(req.query.tagLimit, 16, 40),
      skillLimit: parseLimit(req.query.skillLimit, 6, 12),
      skillMode: typeof req.query.skillMode === 'string' ? req.query.skillMode.toLowerCase() : 'llm',
      skillRefreshHours: parseLimit(req.query.skillRefreshHours, 6, 72),
    });

    return res.json(context);
  } catch (error) {
    console.error('Error fetching agent pod context:', error);
    return res.status(500).json({ message: 'Failed to fetch pod context' });
  }
});

router.get('/pods/:podId/messages', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = req.agentInstallation;

    if (!ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const messages = await AgentMessageService.getRecentMessages(podId, limit);

    return res.json({ messages });
  } catch (error) {
    console.error('Error fetching pod messages:', error);
    return res.status(500).json({ message: 'Failed to fetch messages' });
  }
});

router.post('/pods/:podId/messages', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = req.agentInstallation;

    if (!ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const { content, metadata, messageType } = req.body || {};
    const result = await AgentMessageService.postMessage({
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
      displayName: installation.displayName,
      podId,
      content,
      metadata,
      messageType,
    });

    return res.json(result);
  } catch (error) {
    console.error('Error posting agent message:', error);
    return res.status(500).json({ message: error.message || 'Failed to post message' });
  }
});

module.exports = router;
