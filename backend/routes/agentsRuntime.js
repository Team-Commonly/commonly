const express = require('express');

const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const AgentEventService = require('../services/agentEventService');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentMessageService = require('../services/agentMessageService');
const AgentThreadService = require('../services/agentThreadService');
const PodContextService = require('../services/podContextService');
const SocialPolicyService = require('../services/socialPolicyService');
const registry = require('../integrations');
const Activity = require('../models/Activity');
const User = require('../models/User');
const Post = require('../models/Post');
const { AgentInstallation } = require('../models/AgentRegistry');
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');

const Integration = require('../models/Integration');

const router = express.Router();
const parseNonNegativeInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, parsed);
};

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, parsed);
};

const INTEGRATION_PUBLISH_COOLDOWN_SECONDS = parseNonNegativeInt(
  process.env.AGENT_INTEGRATION_PUBLISH_COOLDOWN_SECONDS,
  1800,
);
const INTEGRATION_PUBLISH_DAILY_LIMIT = parsePositiveInt(
  process.env.AGENT_INTEGRATION_PUBLISH_DAILY_LIMIT,
  24,
);

const ensurePodMatch = (installationOrList, podId) => {
  if (Array.isArray(installationOrList)) {
    return installationOrList.some((installation) => (
      installation?.podId?.toString() === podId.toString()
    ));
  }
  return installationOrList?.podId?.toString() === podId.toString();
};

const resolveInstallationForPod = (installations = [], fallback, podId) => {
  if (!Array.isArray(installations)) return fallback;
  return installations.find((installation) => (
    installation?.podId?.toString() === podId.toString()
  )) || fallback;
};

const hasAnyScope = (installation, acceptedScopes = []) => {
  const scopes = installation?.scopes || [];
  return acceptedScopes.some((scope) => scopes.includes(scope));
};

const mapBufferedIntegrationMessages = (integration, {
  limit = 100,
  before,
  after,
} = {}) => {
  const buffer = Array.isArray(integration?.config?.messageBuffer)
    ? integration.config.messageBuffer
    : [];
  let messages = buffer
    .map((entry) => ({
      id: entry?.messageId ? String(entry.messageId) : null,
      content: String(entry?.content || ''),
      author: String(entry?.authorName || ''),
      authorId: entry?.authorId ? String(entry.authorId) : null,
      timestamp: entry?.timestamp || null,
      metadata: entry?.metadata || {},
    }))
    .filter((entry) => entry.id && entry.timestamp);

  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.valueOf())) {
      messages = messages.filter((entry) => new Date(entry.timestamp) < beforeDate);
    }
  }
  if (after) {
    const afterDate = new Date(after);
    if (!Number.isNaN(afterDate.valueOf())) {
      messages = messages.filter((entry) => new Date(entry.timestamp) > afterDate);
    }
  }

  messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return messages.slice(0, limit);
};

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
    const agentUser = req.agentUser;
    const agentName = installation?.agentName
      || agentUser?.botMetadata?.agentName
      || agentUser?.botMetadata?.agentType
      || agentUser?.username;
    const instanceId = installation?.instanceId
      || agentUser?.botMetadata?.instanceId
      || 'default';
    if (!agentName) {
      return res.status(403).json({ message: 'Agent token not authorized for events' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const podIds = (req.agentInstallations || [])
      .map((item) => item?.podId)
      .filter(Boolean);

    const events = await AgentEventService.list({
      agentName,
      instanceId,
      podId: installation?.podId,
      podIds,
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
    const delivery = req.body?.result || req.body?.delivery || null;
    await AgentEventService.acknowledge(req.params.id, resolvedAgentName, instanceId, delivery);

    return res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging bot event:', error);
    return res.status(500).json({ message: 'Failed to acknowledge bot event' });
  }
});

router.post('/events/:id/ack', agentRuntimeAuth, async (req, res) => {
  try {
    const installation = req.agentInstallation;
    const agentUser = req.agentUser;
    const agentName = installation?.agentName
      || agentUser?.botMetadata?.agentName
      || agentUser?.botMetadata?.agentType
      || agentUser?.username;
    const instanceId = installation?.instanceId
      || agentUser?.botMetadata?.instanceId
      || 'default';
    if (!agentName) {
      return res.status(403).json({ message: 'Agent token not authorized for events' });
    }
    const delivery = req.body?.result || req.body?.delivery || null;
    await AgentEventService.acknowledge(
      req.params.id,
      agentName,
      instanceId,
      delivery,
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
        agentContext: { agentName: resolvedAgentName, instanceId },
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

/**
 * POST /bot/threads/:threadId/comments (user API token auth)
 * Post a thread comment as the agent (bot user token).
 */
router.post(
  '/bot/threads/:threadId/comments',
  auth,
  requireApiTokenScopes(['agent:messages:write']),
  async (req, res) => {
    try {
      const { threadId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.body.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.body.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const { content, podId: requestPodId } = req.body || {};
      if (!content) {
        return res.status(400).json({ message: 'content is required' });
      }

      const post = await Post.findById(threadId).select('_id podId').lean();
      if (!post) {
        return res.status(404).json({ message: 'Thread not found' });
      }

      const targetPodId = post?.podId || requestPodId;
      if (!targetPodId) {
        return res.status(400).json({ message: 'podId is required for threads without a pod' });
      }

      const installation = await ensureBotInstallation(resolvedAgentName, targetPodId, instanceId);
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      const result = await AgentThreadService.postComment({
        agentName: resolvedAgentName,
        instanceId,
        displayName: installation.displayName,
        threadId,
        content,
      });

      return res.json(result);
    } catch (error) {
      console.error('Error posting bot thread comment:', error);
      return res.status(500).json({ message: error.message || 'Failed to post comment' });
    }
  },
);

router.get('/pods/:podId/context', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
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
      agentContext: { agentName: installation.agentName, instanceId: installation.instanceId || 'default' },
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
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
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
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
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

router.post('/pods/:podId/summaries', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const {
      summary,
      summaryType = 'chats',
      source = 'agent',
      sourceLabel = 'Agent',
      title,
      messageCount = 0,
      timeRange = null,
      eventId = null,
    } = req.body || {};

    const summaryText = typeof summary === 'string'
      ? summary
      : (summary?.content || summary?.summary || '');
    if (!summaryText || !String(summaryText).trim()) {
      return res.status(400).json({ message: 'summary is required' });
    }

    const structuredPayload = {
      type: summaryType,
      source,
      sourceLabel,
      summary: String(summaryText).trim(),
      title: title || null,
      messageCount: Number.isFinite(Number(messageCount)) ? Number(messageCount) : 0,
      timeRange: timeRange || undefined,
      eventId: eventId || undefined,
    };

    const persisted = await AgentMessageService.persistSummaryFromAgentMessage({
      agentName: installation.agentName,
      podId,
      content: `[BOT_MESSAGE]${JSON.stringify(structuredPayload)}`,
      metadata: {
        summaryType,
        source,
        messageCount: structuredPayload.messageCount,
        timeRange: structuredPayload.timeRange || undefined,
        eventId: structuredPayload.eventId || undefined,
      },
    });

    return res.json({
      success: true,
      summary: persisted
        ? {
          id: persisted._id?.toString?.() || persisted._id,
          type: persisted.type,
          title: persisted.title,
          content: persisted.content,
          createdAt: persisted.createdAt,
        }
        : null,
    });
  } catch (error) {
    console.error('Error persisting agent summary:', error);
    return res.status(500).json({ message: error.message || 'Failed to persist summary' });
  }
});

/**
 * POST /threads/:threadId/comments (agent runtime token auth)
 */
router.post('/threads/:threadId/comments', agentRuntimeAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const installation = req.agentInstallation;

    const { content } = req.body || {};
    if (!content) {
      return res.status(400).json({ message: 'content is required' });
    }

    const post = await Post.findById(threadId).select('_id podId').lean();
    if (!post) {
      return res.status(404).json({ message: 'Thread not found' });
    }

    if (post.podId && !ensurePodMatch(req.agentInstallations || installation, post.podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const resolvedInstallation = post.podId
      ? resolveInstallationForPod(req.agentInstallations, installation, post.podId)
      : installation;

    const result = await AgentThreadService.postComment({
      agentName: resolvedInstallation.agentName,
      instanceId: resolvedInstallation.instanceId || 'default',
      displayName: resolvedInstallation.displayName,
      threadId,
      content,
    });

    return res.json(result);
  } catch (error) {
    console.error('Error posting agent thread comment:', error);
    return res.status(500).json({ message: error.message || 'Failed to post comment' });
  }
});

/**
 * GET /pods/:podId/integrations (agent runtime token auth)
 * Get integration configs for a pod that agents can access
 */
router.get('/pods/:podId/integrations', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // Verify agent is installed in this pod
    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    // Verify agent has integration:read scope
    if (!hasAnyScope(installation, ['integration:read', 'integrations:read'])) {
      return res.status(403).json({ message: 'Missing integration:read scope' });
    }

    // Fetch pod-scoped integrations where agent access is enabled.
    const podIntegrations = await Integration.find({
      podId,
      'config.agentAccessEnabled': true,
      status: 'connected',
    }).select('type config').lean();

    // Also include globally shared integrations (ex: global X tokens from admin UI).
    const globalIntegrations = await Integration.find({
      'config.agentAccessEnabled': true,
      'config.globalAgentAccess': true,
      status: 'connected',
      isActive: true,
    }).select('type config').lean();

    const integrations = [...podIntegrations, ...globalIntegrations].filter((integration, index, list) => (
      index === list.findIndex((item) => item._id?.toString() === integration._id?.toString())
    ));

    // Return sanitized integration data
    return res.json({
      integrations: integrations.map((integration) => ({
        id: integration._id,
        type: integration.type,
        channelId: integration.config?.channelId,
        channelName: integration.config?.channelName,
        groupId: integration.config?.groupId,
        groupName: integration.config?.groupName,
        // Bot tokens exposed ONLY to agents with proper scopes
        botToken: integration.config?.botToken,
        accessToken: integration.config?.accessToken,
      })),
    });
  } catch (error) {
    console.error('Error fetching integrations for agent:', error);
    return res.status(500).json({ message: 'Failed to fetch integrations' });
  }
});

/**
 * GET /pods/:podId/integrations/:integrationId/messages (agent runtime token auth)
 * Fetch messages from Discord/GroupMe channel
 */
router.get('/pods/:podId/integrations/:integrationId/messages', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId, integrationId } = req.params;
    const {
      limit: rawLimit = '100', before, after,
    } = req.query;

    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // Verify agent is installed in this pod
    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    // Verify agent has integration:messages:read scope
    if (!hasAnyScope(installation, ['integration:messages:read', 'integrations:messages:read'])) {
      return res.status(403).json({ message: 'Missing integration:messages:read scope' });
    }

    // Parse limit with bounds (1-1000)
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), 1000);

    // Fetch integration
    const integration = await Integration.findOne({
      _id: integrationId,
      'config.agentAccessEnabled': true,
      status: 'connected',
      isActive: true,
      $or: [
        { podId },
        { 'config.globalAgentAccess': true },
      ],
    }).lean();

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found or agent access disabled' });
    }

    // Fetch messages from provider API or normalized integration buffer.
    let messages = [];

    if (integration.type === 'discord') {
      if (!integration.config?.botToken) {
        return res.status(400).json({ message: 'Discord integration missing botToken' });
      }
      const DiscordService = require('../services/discordService');
      messages = await DiscordService.fetchMessages({
        channelId: integration.config.channelId,
        botToken: integration.config.botToken,
        limit,
        before,
        after,
      });
    } else if (integration.type === 'groupme') {
      if (!integration.config?.accessToken || !integration.config?.groupId) {
        return res.status(400).json({ message: 'GroupMe integration missing accessToken or groupId' });
      }
      const GroupMeService = require('../services/groupmeService');
      messages = await GroupMeService.fetchMessages({
        groupId: integration.config.groupId,
        accessToken: integration.config.accessToken,
        limit,
        before,
        after,
      });
    } else if (integration.type === 'x' || integration.type === 'instagram') {
      messages = mapBufferedIntegrationMessages(integration, { limit, before, after });
    } else {
      return res.status(400).json({ message: `Integration type ${integration.type} does not support message fetching` });
    }

    return res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages for agent:', error);
    return res.status(500).json({ message: error.message || 'Failed to fetch messages' });
  }
});

/**
 * GET /pods/:podId/social-policy (agent runtime token auth)
 * Returns effective global social publish policy.
 */
router.get('/pods/:podId/social-policy', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );
    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }
    const policy = await SocialPolicyService.getPolicy();
    return res.json({ policy });
  } catch (error) {
    console.error('Error fetching social policy for agent:', error);
    return res.status(500).json({ message: 'Failed to fetch social policy' });
  }
});

/**
 * POST /pods/:podId/integrations/:integrationId/publish (agent runtime token auth)
 * Publish curated content to an external integration (X/Instagram).
 */
router.post('/pods/:podId/integrations/:integrationId/publish', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId, integrationId } = req.params;
    const {
      text,
      caption,
      imageUrl,
      hashtags,
      sourceUrl,
    } = req.body || {};

    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // Verify agent is installed in this pod
    if (!ensurePodMatch(req.agentInstallations || installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    // Verify integration write scope
    if (!hasAnyScope(installation, ['integration:write', 'integrations:write'])) {
      return res.status(403).json({ message: 'Missing integration:write scope' });
    }

    const integration = await Integration.findOne({
      _id: integrationId,
      podId,
      'config.agentAccessEnabled': true,
      status: 'connected',
      isActive: true,
    }).lean();

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found or agent access disabled' });
    }

    const socialPolicy = await SocialPolicyService.getPolicy();
    if (!socialPolicy.publishEnabled) {
      return res.status(403).json({ message: 'Global social publishing is disabled by policy' });
    }

    const hasSourceUrl = Boolean(String(sourceUrl || '').trim());
    if (socialPolicy.strictAttribution && !hasSourceUrl) {
      return res.status(400).json({ message: 'sourceUrl is required by strict attribution policy' });
    }

    const baseText = String(text || '').trim();
    const baseCaption = String(caption || '').trim();
    const publishPayload = {
      text: baseText,
      caption: baseCaption,
      imageUrl,
      hashtags: Array.isArray(hashtags) ? hashtags : [],
      sourceUrl: hasSourceUrl ? String(sourceUrl).trim() : undefined,
    };
    if (socialPolicy.socialMode === 'repost') {
      if (!publishPayload.sourceUrl) {
        return res.status(400).json({ message: 'sourceUrl is required for repost mode' });
      }
      // Enforce link-first posting in repost mode.
      const repostPrefix = 'Shared via Commonly';
      publishPayload.text = repostPrefix;
      publishPayload.caption = repostPrefix;
    }

    const now = new Date();
    const lastPublishAt = integration.config?.lastAgentPublishAt
      ? new Date(integration.config.lastAgentPublishAt)
      : null;
    if (INTEGRATION_PUBLISH_COOLDOWN_SECONDS > 0 && lastPublishAt && !Number.isNaN(lastPublishAt.valueOf())) {
      const elapsedSeconds = Math.floor((now.getTime() - lastPublishAt.getTime()) / 1000);
      if (elapsedSeconds < INTEGRATION_PUBLISH_COOLDOWN_SECONDS) {
        return res.status(429).json({
          message: 'Publish cooldown active for this integration',
          retryAfterSeconds: INTEGRATION_PUBLISH_COOLDOWN_SECONDS - elapsedSeconds,
        });
      }
    }

    const windowStartRaw = integration.config?.agentPublishWindowStart;
    const windowStart = windowStartRaw ? new Date(windowStartRaw) : null;
    const hasValidWindow = windowStart && !Number.isNaN(windowStart.valueOf())
      && (now.getTime() - windowStart.getTime()) < (24 * 60 * 60 * 1000);
    const publishWindowStart = hasValidWindow ? windowStart : now;
    const publishWindowCount = hasValidWindow
      ? Number(integration.config?.agentPublishWindowCount || 0)
      : 0;
    if (publishWindowCount >= INTEGRATION_PUBLISH_DAILY_LIMIT) {
      return res.status(429).json({
        message: 'Daily publish limit reached for this integration',
        limit: INTEGRATION_PUBLISH_DAILY_LIMIT,
      });
    }

    const provider = registry.get(integration.type, integration);
    if (typeof provider.publishPost !== 'function') {
      return res.status(400).json({ message: `Integration type ${integration.type} does not support publishing` });
    }

    const result = await provider.publishPost(publishPayload);

    await Integration.updateOne(
      { _id: integrationId },
      {
        $set: {
          'config.lastAgentPublishAt': now,
          'config.lastAgentPublishBy': `${installation.agentName}:${installation.instanceId || 'default'}`,
          'config.agentPublishWindowStart': publishWindowStart,
          'config.agentPublishWindowCount': publishWindowCount + 1,
        },
      },
    );

    try {
      const actorName = req.agentUser?.botMetadata?.displayName
        || req.agentUser?.username
        || installation.agentName;
      await Activity.create({
        type: 'agent_action',
        actor: {
          id: req.agentUser?._id || null,
          name: actorName,
          type: 'agent',
          verified: true,
        },
        action: 'integration_publish',
        content: `Published content to ${integration.type} integration.`,
        podId,
        sourceType: 'event',
        sourceId: result?.externalId || undefined,
        agentMetadata: {
          agentName: installation.agentName,
          sources: result?.url ? [{ title: `${integration.type} post`, url: result.url }] : [],
          confidence: socialPolicy.socialMode === 'rewrite' ? 0.8 : 1.0,
        },
      });
    } catch (activityError) {
      console.warn('Failed to log integration publish activity:', activityError.message);
    }

    return res.json({ success: true, result });
  } catch (error) {
    console.error('Error publishing via integration for agent:', error);
    return res.status(500).json({ message: error.message || 'Failed to publish via integration' });
  }
});

module.exports = router;
