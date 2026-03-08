const express = require('express');

const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const AgentEventService = require('../services/agentEventService');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentMessageService = require('../services/agentMessageService');
const AgentThreadService = require('../services/agentThreadService');
const PodContextService = require('../services/podContextService');
const GlobalModelConfigService = require('../services/globalModelConfigService');
const SocialPolicyService = require('../services/socialPolicyService');
const registry = require('../integrations');
const Activity = require('../models/Activity');
const User = require('../models/User');
const Post = require('../models/Post');
const Pod = require('../models/Pod');
const { AgentInstallation } = require('../models/AgentRegistry');
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');

const Integration = require('../models/Integration');
const AgentMemory = require('../models/AgentMemory');
const DMService = require('../services/dmService');
const ChatSummarizerService = require('../services/chatSummarizerService');

let PGPod;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (_) {
  PGPod = null;
}

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

const ensurePodMatch = (installationOrList, podId, authorizedPodIds = []) => {
  const normalizedPodId = podId?.toString?.() || String(podId || '');
  if (Array.isArray(authorizedPodIds) && authorizedPodIds.length > 0) {
    return authorizedPodIds.some((id) => String(id) === normalizedPodId);
  }
  if (Array.isArray(installationOrList)) {
    return installationOrList.some((installation) => (
      installation?.podId?.toString() === normalizedPodId
    ));
  }
  return installationOrList?.podId?.toString() === normalizedPodId;
};

const resolveInstallationForPod = (installations = [], fallback, podId) => {
  if (!Array.isArray(installations)) return fallback;
  return installations.find((installation) => (
    installation?.podId?.toString() === podId.toString()
  )) || fallback;
};

const hasAnyScope = (installation, acceptedScopes = []) => {
  const scopes = Array.isArray(installation?.scopes) ? installation.scopes : [];
  // Backward compatibility: installations created before scope persistence
  // should behave as unscoped/full-access for runtime integration routes.
  if (scopes.length === 0) return true;
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

const ensureBotInstallation = async (
  agentName,
  podId,
  statuses = ['active'],
  instanceId = 'default',
) => {
  const installation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    status: { $in: statuses },
  }).lean();
  return installation;
};

const ensureBotPodAccess = async (
  user,
  agentName,
  podId,
  statuses = ['active'],
  instanceId = 'default',
) => {
  const installation = await ensureBotInstallation(agentName, podId, statuses, instanceId);
  if (installation) return installation;

  const dmPod = await Pod.findOne({
    _id: podId,
    type: 'agent-admin',
    members: user?._id,
  }).select('_id').lean();
  if (!dmPod) return null;

  const fallbackInstallation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    instanceId,
    status: { $in: statuses },
  }).sort({ updatedAt: -1 }).lean();

  if (fallbackInstallation) return fallbackInstallation;
  return {
    agentName: agentName.toLowerCase(),
    instanceId,
    displayName: user?.botMetadata?.displayName || user?.name || agentName,
    config: {},
  };
};

/**
 * GET /installations (agent runtime token auth)
 * Returns all active pod installations for the authenticated agent, including
 * pod name and type so the runtime can self-discover where it is installed.
 */
router.get('/installations', agentRuntimeAuth, async (req, res) => {
  try {
    const installations = req.agentInstallations || [];
    const agentInstallation = req.agentInstallation;

    const agentName = agentInstallation?.agentName
      || req.agentUser?.botMetadata?.agentName
      || req.agentUser?.botMetadata?.agentType
      || req.agentUser?.username;
    const instanceId = agentInstallation?.instanceId
      || req.agentUser?.botMetadata?.instanceId
      || 'default';

    const podIds = installations
      .map((inst) => inst?.podId)
      .filter(Boolean);

    // Also include DM pods the agent is a member of
    const dmPodIds = (req.agentAuthorizedPodIds || []).filter(
      (id) => !podIds.map(String).includes(String(id)),
    );

    const allPodIds = [...podIds.map(String), ...dmPodIds.map(String)];

    const pods = allPodIds.length > 0
      ? await Pod.find({ _id: { $in: allPodIds } }).select('_id name type').lean()
      : [];

    const podMap = Object.fromEntries(pods.map((p) => [String(p._id), p]));

    const installationList = installations.map((inst) => {
      const pod = podMap[String(inst?.podId)] || {};
      return {
        podId: String(inst?.podId || ''),
        podName: pod.name || null,
        podType: pod.type || null,
        instanceId: inst?.instanceId || instanceId,
        status: inst?.status || 'active',
        type: 'installation',
      };
    });

    const dmList = dmPodIds.map((id) => {
      const pod = podMap[String(id)] || {};
      return {
        podId: String(id),
        podName: pod.name || null,
        podType: pod.type || 'agent-admin',
        instanceId,
        status: 'active',
        type: 'dm',
      };
    });

    return res.json({
      agentName,
      instanceId,
      installations: [...installationList, ...dmList],
    });
  } catch (error) {
    console.error('Error fetching agent installations:', error.message || error);
    return res.status(500).json({ message: 'Failed to fetch installations' });
  }
});

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
    const installationPodIds = (req.agentInstallations || [])
      .map((item) => item?.podId)
      .filter(Boolean);
    const dmPods = await Pod.find({
      type: 'agent-admin',
      members: agentUser?._id,
    }).select('_id').lean();
    const dmPodIds = dmPods.map((pod) => pod._id);
    const podIds = Array.from(
      new Set(
        [...installationPodIds, ...dmPodIds]
          .filter(Boolean)
          .map((id) => id.toString()),
      ),
    );
    const fallbackPodId = podIds.length === 0 && installation?.podId
      ? installation.podId
      : undefined;

    const events = await AgentEventService.list({
      agentName,
      instanceId,
      podId: fallbackPodId,
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

    const installationPodIds = installations.map((i) => i.podId);
    const dmPods = await Pod.find({
      type: 'agent-admin',
      members: user._id,
    }).select('_id').lean();
    const dmPodIds = dmPods.map((pod) => pod._id);
    const podIds = Array.from(
      new Set(
        [...installationPodIds, ...dmPodIds]
          .filter(Boolean)
          .map((id) => id.toString()),
      ),
    );

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

router.post('/dm', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const {
      agentName: rawAgentName,
      instanceId: rawInstanceId,
      podId: requestedPodId,
    } = req.body || {};

    const agentName = String(rawAgentName || '').trim().toLowerCase();
    const instanceId = String(rawInstanceId || '').trim() || null;
    const normalizedInstanceId = instanceId ? String(instanceId).toLowerCase() : null;
    if (!agentName) {
      return res.status(400).json({ message: 'agentName is required' });
    }

    const installationQuery = {
      agentName,
      status: 'active',
    };
    if (instanceId) installationQuery.instanceId = instanceId;
    if (requestedPodId) installationQuery.podId = requestedPodId;

    let installations = await AgentInstallation.find(installationQuery)
      .select('agentName instanceId podId installedBy')
      .lean();

    // Backward-compat fallback for stale clients that still send
    // instanceId=default when only one non-default instance is installed.
    if (!installations.length && instanceId) {
      const fallbackQuery = {
        agentName,
        status: 'active',
      };
      if (requestedPodId) fallbackQuery.podId = requestedPodId;
      const fallbackInstalls = await AgentInstallation.find(fallbackQuery)
        .select('agentName instanceId podId installedBy')
        .limit(2)
        .lean();
      if (fallbackInstalls.length === 1) {
        installations = fallbackInstalls;
      }
    }

    if (!installations.length) {
      return res.status(404).json({ message: 'No active installation found for that agent' });
    }

    const candidatePodIds = installations
      .map((installation) => installation.podId)
      .filter(Boolean);
    const accessiblePods = await Pod.find({
      _id: { $in: candidatePodIds },
      members: userId,
    }).select('_id').lean();
    const accessiblePodIdSet = new Set(
      accessiblePods.map((pod) => pod._id.toString()),
    );

    const authorizedInstallations = installations.filter((installation) => (
      String(installation.installedBy || '') === String(userId)
      || accessiblePodIdSet.has(String(installation.podId))
    ));

    if (!authorizedInstallations.length) {
      return res.status(403).json({ message: 'Not authorized to message this agent' });
    }

    const normalizedInstalls = authorizedInstallations.map((installation) => ({
      ...installation,
      instanceId: String(installation.instanceId || 'default'),
    }));
    const byExactInstance = normalizedInstanceId
      ? normalizedInstalls.filter(
        (installation) => installation.instanceId.toLowerCase() === normalizedInstanceId,
      )
      : [];

    let selectedInstallation = null;
    if (byExactInstance.length === 1) {
      selectedInstallation = byExactInstance[0];
    } else if (byExactInstance.length > 1) {
      return res.status(409).json({
        message: 'Multiple installations match that instanceId. Specify podId.',
      });
    } else if (normalizedInstanceId === 'default' && normalizedInstalls.length === 1) {
      // Backward compatibility: stale clients may still send default.
      selectedInstallation = normalizedInstalls[0];
    } else if (!normalizedInstanceId && normalizedInstalls.length === 1) {
      selectedInstallation = normalizedInstalls[0];
    } else {
      return res.status(409).json({
        message: 'Multiple installations found. Specify instanceId (and podId if needed).',
        installations: normalizedInstalls.map((installation) => ({
          instanceId: installation.instanceId,
          podId: String(installation.podId || ''),
        })),
      });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(
      selectedInstallation.agentName,
      { instanceId: selectedInstallation.instanceId || 'default' },
    );

    const dmPod = await DMService.getOrCreateAgentDM(agentUser._id, userId, {
      agentName: selectedInstallation.agentName,
      instanceId: selectedInstallation.instanceId || 'default',
    });

    return res.json({ dmPod });
  } catch (error) {
    console.error('Error creating/fetching agent DM:', error);
    return res.status(500).json({ message: 'Failed to create/fetch agent DM' });
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

      const installation = await ensureBotPodAccess(
        user,
        resolvedAgentName,
        podId,
        ['active', 'paused'],
        instanceId,
      );
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

      const installation = await ensureBotPodAccess(
        user,
        resolvedAgentName,
        podId,
        ['active', 'paused'],
        instanceId,
      );
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

      const installation = await ensureBotPodAccess(
        user,
        resolvedAgentName,
        podId,
        ['active'],
        instanceId,
      );
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
        installationConfig: installation.config || null,
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

      const installation = await ensureBotInstallation(
        resolvedAgentName,
        targetPodId,
        ['active'],
        instanceId,
      );
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

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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

    // Resolve context token budget from model config
    let maxContextTokens = 0;
    if (req.query.maxContextTokens) {
      maxContextTokens = parseLimit(req.query.maxContextTokens, 0, 200000);
    } else {
      const modelConfig = await GlobalModelConfigService.getConfig().catch(() => null);
      const contextLimit = modelConfig?.llmService?.contextLimit || 0;
      // Reserve 25% of model context for system prompt + output
      if (contextLimit > 0) {
        maxContextTokens = Math.floor(contextLimit * 0.75);
      }
    }

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
      maxContextTokens,
    });

    return res.json(context);
  } catch (error) {
    let statusCode = 500;
    if (error.status) statusCode = error.status;
    else if (error.code === 'POD_NOT_FOUND') statusCode = 404;
    else if (error.code === 'NOT_A_MEMBER') statusCode = 403;
    console.error(`Error fetching agent pod context [${statusCode}]:`, error.message || error);
    return res.status(statusCode).json({
      message: error.message || 'Failed to fetch pod context',
      code: error.code || 'INTERNAL_ERROR',
    });
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

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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

/**
 * GET /pods/:podId/posts
 * Recent posts in a pod with comment counts and recent human comments.
 * postId doubles as threadId for commonly_post_thread_comment.
 */
router.get('/pods/:podId/posts', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    if (!ensurePodMatch(req.agentInstallations || req.agentInstallation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    const posts = await Post.find({ podId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'username isBot')
      .populate('comments.userId', 'username isBot')
      .lean();

    const result = posts.map((p) => {
      const allComments = p.comments || [];
      const humanComments = [];
      const agentComments = [];
      for (const c of allComments) {
        if (c.userId?.isBot) agentComments.push(c);
        else humanComments.push(c);
      }
      return {
        postId: p._id.toString(),
        author: p.userId?.username || 'unknown',
        isBot: p.userId?.isBot || false,
        content: (p.content || '').slice(0, 300),
        source: p.source?.url || null,
        createdAt: p.createdAt,
        commentCount: allComments.length,
        humanCommentCount: humanComments.length,
        recentComments: (() => {
          const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
          return humanComments
            .filter((c) => c.createdAt && new Date(c.createdAt) >= cutoff)
            .slice(-5)
            .map((c) => ({
              commentId: c._id?.toString(),
              author: c.userId?.username || 'unknown',
              text: (c.text || '').slice(0, 200),
              replyTo: c.replyTo?.toString() || null,
              createdAt: c.createdAt,
            }));
        })(),
        agentComments: agentComments.slice(-3).map((c) => ({
          commentId: c._id?.toString(),
          author: c.userId?.username || 'unknown',
          text: (c.text || '').slice(0, 60),
          replyTo: c.replyTo?.toString() || null,
          createdAt: c.createdAt,
        })),
      };
    });

    return res.json({ posts: result });
  } catch (error) {
    console.error('Error fetching pod posts:', error);
    return res.status(500).json({ message: 'Failed to fetch posts' });
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

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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
      installationConfig: installation.config || null,
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

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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

    const { content, replyToCommentId } = req.body || {};
    if (!content) {
      return res.status(400).json({ message: 'content is required' });
    }

    const post = await Post.findById(threadId).select('_id podId').lean();
    if (!post) {
      return res.status(404).json({ message: 'Thread not found' });
    }

    if (post.podId && !ensurePodMatch(
      req.agentInstallations || installation,
      post.podId,
      req.agentAuthorizedPodIds,
    )) {
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
      replyToCommentId: replyToCommentId || null,
    });

    return res.json(result);
  } catch (error) {
    console.error('Error posting agent thread comment:', error);
    return res.status(500).json({ message: error.message || 'Failed to post comment' });
  }
});

/**
 * GET /memory (agent runtime token auth)
 * Read this agent's personal MEMORY.md (persistent across sessions)
 */
router.get('/memory', agentRuntimeAuth, async (req, res) => {
  try {
    const agentInstallation = req.agentInstallation;
    const agentName =
      agentInstallation?.agentName ||
      req.agentUser?.botMetadata?.agentName ||
      req.agentUser?.username;
    const instanceId =
      agentInstallation?.instanceId ||
      req.agentUser?.botMetadata?.instanceId ||
      'default';
    if (!agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }
    const record = await AgentMemory.findOne({ agentName, instanceId }).lean();
    return res.json({ content: record?.content ?? '' });
  } catch (err) {
    console.error('GET /memory error:', err);
    return res.status(500).json({ message: 'Failed to read agent memory' });
  }
});

/**
 * PUT /memory (agent runtime token auth)
 * Write this agent's personal MEMORY.md (overwrites full content)
 */
router.put('/memory', agentRuntimeAuth, async (req, res) => {
  try {
    const agentInstallation = req.agentInstallation;
    const agentName =
      agentInstallation?.agentName ||
      req.agentUser?.botMetadata?.agentName ||
      req.agentUser?.username;
    const instanceId =
      agentInstallation?.instanceId ||
      req.agentUser?.botMetadata?.instanceId ||
      'default';
    if (!agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ message: 'content must be a string' });
    }
    await AgentMemory.findOneAndUpdate(
      { agentName, instanceId },
      { content, updatedAt: new Date() },
      { upsert: true, new: true },
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('PUT /memory error:', err);
    return res.status(500).json({ message: 'Failed to write agent memory' });
  }
});

/**
 * POST /posts (agent runtime token auth)
 * Create a post in the feed as the agent's bot user
 */
router.post('/posts', agentRuntimeAuth, async (req, res) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { content, tags, category, podId, source } = req.body || {};
    if (!content) {
      return res.status(400).json({ message: 'content is required' });
    }

    if (podId) {
      const pod = await Pod.findById(podId).select('_id members').lean();
      if (!pod) return res.status(404).json({ message: 'Pod not found' });
      const isMember = pod.members?.some((m) => m.toString() === agentUser._id.toString());
      if (!isMember) {
        return res.status(403).json({ message: 'Agent is not a member of this pod' });
      }
    }

    const resolvedCategory = (category || '').trim() || 'General';
    const resolvedSource = source && typeof source === 'object'
      ? {
        type: source.type || (podId ? 'pod' : 'user'),
        provider: source.provider || 'internal',
        externalId: source.externalId || null,
        url: source.url || null,
        author: source.author || null,
        authorUrl: source.authorUrl || null,
        channel: source.channel || null,
      }
      : { type: podId ? 'pod' : 'user', provider: 'internal' };

    // Dedup: if a post with the same source URL already exists in this pod, return it
    if (resolvedSource.url && podId) {
      const existing = await Post.findOne({ podId, 'source.url': resolvedSource.url }).lean();
      if (existing) {
        return res.status(200).json(existing);
      }
    }

    const post = new Post({
      userId: agentUser._id,
      content,
      tags: Array.isArray(tags) ? tags : [],
      podId: podId || null,
      category: resolvedCategory,
      source: resolvedSource,
    });
    await post.save();

    return res.status(201).json(post);
  } catch (error) {
    console.error('Error creating agent post:', error);
    return res.status(500).json({ message: error.message || 'Failed to create post' });
  }
});

/**
 * Ensure the summarizer bot is installed (or reactivated) in a pod.
 * Silently no-ops if already active.
 */
async function ensureCommonlyBotInstalled(podId, installedBy) {
  try {
    await AgentInstallation.install('commonly-bot', podId, {
      version: '1.0.0',
      config: {},
      scopes: ['context:read', 'summaries:read'],
      installedBy,
      instanceId: 'default',
      displayName: 'Commonly Summarizer',
    });
  } catch (err) {
    if (!err.message?.includes('already installed')) throw err;
  }
}

/**
 * GET /pods (agent runtime token auth)
 * List public pods the agent can discover and join.
 * Returns pods ordered by recent activity, excluding DM pods.
 */
router.get('/pods', agentRuntimeAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const pods = await Pod.find({ type: { $ne: 'dm' } })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select('name description type members updatedAt')
      .lean();

    const authorizedPodIds = new Set((req.agentAuthorizedPodIds || []).map((id) => id.toString()));

    // Batch-fetch bot user IDs and pod summaries in parallel
    const allMemberIds = [...new Set(
      pods.flatMap((p) => (p.members || []).map((id) => id.toString())),
    )];
    const podIdStrings = pods.map((p) => p._id.toString());

    const [bots, summaryMapResult] = await Promise.all([
      allMemberIds.length > 0
        ? User.find({ _id: { $in: allMemberIds }, isBot: true }).select('_id').lean()
        : Promise.resolve([]),
      ChatSummarizerService.getMultiplePodSummaries(podIdStrings).catch((summaryErr) => {
        console.warn('[GET /pods] Failed to fetch pod summaries:', summaryErr.message);
        return {};
      }),
    ]);
    const botUserIds = new Set(bots.map((b) => b._id.toString()));
    const summaryMap = summaryMapResult;

    const result = pods.map((p) => {
      const members = p.members || [];
      const humanMemberCount = members.filter(
        (id) => !botUserIds.has(id.toString()),
      ).length;
      const podIdStr = p._id.toString();
      const latestSummary = summaryMap[podIdStr];
      return {
        podId: podIdStr,
        name: p.name,
        description: p.description || null,
        latestSummary: latestSummary ? latestSummary.content : null,
        type: p.type,
        memberCount: members.length,
        humanMemberCount,
        isMember: authorizedPodIds.has(podIdStr),
        updatedAt: p.updatedAt,
      };
    });

    return res.json({ pods: result });
  } catch (error) {
    console.error('Error listing pods:', error);
    return res.status(500).json({ message: 'Failed to list pods' });
  }
});

/**
 * POST /pods (agent runtime token auth)
 * Create a new pod as the agent's bot user
 */
router.post('/pods', agentRuntimeAuth, async (req, res) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { description, type } = req.body || {};
    // Strip common agent-added prefixes (e.g. "X: ") and normalise whitespace
    const BAD_PREFIXES = /^(X:\s*)/i;
    const rawName = (req.body?.name || '').trim();
    const name = rawName.replace(BAD_PREFIXES, '').trim();

    if (!name || !type) {
      return res.status(400).json({ message: 'name and type are required' });
    }

    const VALID_POD_TYPES = ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin'];
    if (!VALID_POD_TYPES.includes(type)) {
      return res.status(400).json({ message: `Invalid pod type. Must be one of: ${VALID_POD_TYPES.join(', ')}` });
    }

    // Global dedup by name: if a pod with this name already exists anywhere, join it and return it
    const existingPod = await Pod.findOne({ name })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture');
    if (existingPod) {
      const isMember = existingPod.members?.some((m) => m._id.toString() === agentUser._id.toString());
      if (!isMember) {
        existingPod.members.push(agentUser._id);
        await existingPod.save();
        await existingPod.populate('members', 'username profilePicture');
      }
      // Ensure an AgentInstallation exists so the agent appears in the Agents section
      const sourceInstall = req.agentInstallation || (req.agentInstallations || [])[0];
      if (sourceInstall) {
        try {
          const existing = await AgentInstallation.findOne({
            agentName: sourceInstall.agentName,
            podId: existingPod._id,
            instanceId: sourceInstall.instanceId || 'default',
          });
          if (!existing) {
            await AgentInstallation.install(sourceInstall.agentName, existingPod._id, {
              version: sourceInstall.version || '1.0.0',
              config: {
                ...(sourceInstall.config || {}),
                heartbeat: { enabled: false },
                autonomy: {
                  ...(sourceInstall.config?.autonomy || {}),
                  autoJoined: true,
                  autoJoinedFromPodId: sourceInstall.podId?.toString(),
                  autoJoinSource: 'pod-dedup',
                },
              },
              scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
              installedBy: agentUser._id,
              instanceId: sourceInstall.instanceId || 'default',
              displayName: sourceInstall.displayName,
            });
          }
        } catch (installErr) {
          console.warn('[agent] auto-install on pod dedup failed:', installErr.message);
        }
      }
      // Ensure commonly-bot is installed on deduplicated pod too
      try {
        await ensureCommonlyBotInstalled(existingPod._id, agentUser._id);
      } catch (summarizerErr) {
        console.warn('[agent] auto-install commonly-bot on pod dedup failed:', summarizerErr.message);
      }
      return res.status(200).json(existingPod);
    }

    const newPod = new Pod({
      name,
      description,
      type,
      createdBy: agentUser._id,
      members: [agentUser._id],
    });
    const pod = await newPod.save();

    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.create(name, description, type, agentUser._id.toString(), pod._id.toString());
      } catch (pgErr) {
        console.error('Error creating agent pod in PostgreSQL:', pgErr.message);
      }
    }

    // Auto-install the creating agent into the new pod so it can post immediately
    const sourceInstall = req.agentInstallation || (req.agentInstallations || [])[0];
    if (sourceInstall) {
      try {
        const mergedConfig = {
          ...(sourceInstall.config || {}),
          // Agent-created pods never get heartbeat — the agent manages them directly
          heartbeat: { enabled: false },
          autonomy: {
            ...(sourceInstall.config?.autonomy || {}),
            autoJoined: true,
            autoJoinedFromPodId: sourceInstall.podId?.toString(),
            autoJoinSource: 'pod-create',
          },
        };
        await AgentInstallation.install(sourceInstall.agentName, pod._id, {
          version: sourceInstall.version || '1.0.0',
          config: mergedConfig,
          scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
          installedBy: agentUser._id,
          instanceId: sourceInstall.instanceId || 'default',
          displayName: sourceInstall.displayName,
        });
        await AgentIdentityService.ensureAgentInPod(agentUser, pod._id);
      } catch (installErr) {
        console.warn('[agent] auto-install on pod create failed:', installErr.message);
      }
    }

    // Auto-install commonly-bot (summarizer) in every new pod
    try {
      await ensureCommonlyBotInstalled(pod._id, agentUser._id);
    } catch (summarizerErr) {
      console.warn('[agent] auto-install commonly-bot on pod create failed:', summarizerErr.message);
    }

    return res.status(201).json(pod);
  } catch (error) {
    console.error('Error creating agent pod:', error);
    return res.status(500).json({ message: error.message || 'Failed to create pod' });
  }
});

/**
 * POST /pods/:podId/self-install (agent runtime token auth)
 * Let an agent install itself into an agent-owned pod (or any pod it's already a member of).
 * Requires the pod to have been created by a bot user, OR the agent user to be in the pod's
 * member list. This allows agents to join pods they (or other agents) created without waiting
 * for the 2-hour auto-join cron.
 */
router.post('/pods/:podId/self-install', agentRuntimeAuth, async (req, res) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { podId } = req.params;
    const pod = await Pod.findById(podId).select('_id name type createdBy members').lean();
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Allow self-install if: pod was created by any bot user, OR agent is already a member
    const creator = await User.findById(pod.createdBy).select('isBot').lean();
    const isAgentOwned = creator?.isBot === true;
    const isMember = (pod.members || []).some((m) => m.toString() === agentUser._id.toString());

    if (!isAgentOwned && !isMember) {
      return res.status(403).json({ message: 'Self-install is only allowed for agent-owned pods or pods you are a member of' });
    }

    const sourceInstall = req.agentInstallation || (req.agentInstallations || [])[0];
    if (!sourceInstall) {
      return res.status(403).json({ message: 'No active installation found for this agent' });
    }

    const alreadyInstalled = await AgentInstallation.isInstalled(
      sourceInstall.agentName,
      podId,
      sourceInstall.instanceId || 'default',
    );
    if (alreadyInstalled) {
      return res.json({ message: 'Already installed', podId, alreadyInstalled: true });
    }

    const mergedConfig = {
      ...(sourceInstall.config || {}),
      // Agent self-installed pods never get heartbeat — prevents cascading heartbeat explosion
      heartbeat: { enabled: false },
      autonomy: {
        ...(sourceInstall.config?.autonomy || {}),
        autoJoined: true,
        autoJoinedFromPodId: sourceInstall.podId?.toString(),
        autoJoinSource: 'self-install',
      },
    };

    const installation = await AgentInstallation.install(sourceInstall.agentName, podId, {
      version: sourceInstall.version || '1.0.0',
      config: mergedConfig,
      scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
      installedBy: agentUser._id,
      instanceId: sourceInstall.instanceId || 'default',
      displayName: sourceInstall.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    return res.status(201).json({ message: 'Self-installed successfully', podId, installationId: installation._id });
  } catch (error) {
    console.error('Error in agent self-install:', error);
    return res.status(500).json({ message: error.message || 'Failed to self-install' });
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
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
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
