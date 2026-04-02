const express = require('express');

const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const AgentEventService = require('../services/agentEventService');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentMessageService = require('../services/agentMessageService');
const AgentRuntimeRequestService = require('../services/agentRuntimeRequestService');
const AgentThreadService = require('../services/agentThreadService');
const PodContextService = require('../services/podContextService');
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');

const router = express.Router();

/**
 * GET /events (agent runtime token auth)
 * Original endpoint for agent runtime tokens (cm_agent_*)
 */
router.get('/events', agentRuntimeAuth, async (req, res) => {
  try {
    const installation = req.agentInstallation;
    const limit = AgentRuntimeRequestService.parseLimit(req.query.limit, 20, 50);

    const events = await AgentEventService.list({
      agentName: installation.agentName,
      instanceId: installation.instanceId || AgentRuntimeRequestService.DEFAULT_INSTANCE_ID,
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
    const { agentName, instanceId, error } = await AgentRuntimeRequestService
      .requireBotRequestContext(req, res);
    if (error) return error;

    const limit = AgentRuntimeRequestService.parseLimit(req.query.limit, 20, 50);

    // Find all pods where this agent is installed
    const installations = await AgentRuntimeRequestService
      .listAgentInstallations(agentName, instanceId);

    const podIds = installations.map((i) => i.podId);

    // List events across all installed pods
    const events = await AgentEventService.list({
      agentName,
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
    const { agentName, instanceId, error } = await AgentRuntimeRequestService
      .requireBotRequestContext(req, res, { source: 'body' });
    if (error) return error;
    await AgentEventService.acknowledge(req.params.id, agentName, instanceId);

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
      installation.instanceId || AgentRuntimeRequestService.DEFAULT_INSTANCE_ID,
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
      const {
        user,
        agentName,
        instanceId,
        error,
      } = await AgentRuntimeRequestService.requireBotRequestContext(req, res, { podId });
      if (error) return error;

      await AgentIdentityService.ensureAgentInPod(user, podId);

      const context = await PodContextService.getPodContext(
        AgentRuntimeRequestService.buildContextRequest(req.query, {
          podId,
          userId: user._id,
          agentName,
          instanceId,
        }),
      );

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
      const { error } = await AgentRuntimeRequestService
        .requireBotRequestContext(req, res, { podId });
      if (error) return error;
      const limit = AgentRuntimeRequestService.parseLimit(req.query.limit, 20, 50);
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
      const {
        installation,
        agentName,
        instanceId,
        error,
      } = await AgentRuntimeRequestService.requireBotRequestContext(req, res, {
        podId,
        source: 'body',
      });
      if (error) return error;

      const { content, metadata, messageType } = req.body || {};
      const result = await AgentMessageService.postMessage({
        agentName,
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
      const { content, podId: requestPodId } = req.body || {};
      if (!content) {
        return res.status(400).json({ message: 'content is required' });
      }

      const post = await AgentRuntimeRequestService.loadThreadPost(threadId);
      if (!post) {
        return res.status(404).json({ message: 'Thread not found' });
      }

      const targetPodId = AgentRuntimeRequestService.resolveThreadTargetPod(post, requestPodId);
      if (!targetPodId) {
        return res.status(400).json({ message: 'podId is required for threads without a pod' });
      }

      const access = await AgentRuntimeRequestService.requireBotRequestContext(req, res, {
        podId: targetPodId,
        source: 'body',
      });
      if (access.error) {
        return access.error;
      }

      const result = await AgentThreadService.postComment({
        agentName: access.agentName,
        instanceId: access.instanceId,
        displayName: access.installation.displayName,
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
    const installation = req.agentInstallation;

    if (!AgentRuntimeRequestService.ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(installation.agentName, {
      instanceId: installation.instanceId || AgentRuntimeRequestService.DEFAULT_INSTANCE_ID,
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    const context = await PodContextService.getPodContext(
      AgentRuntimeRequestService.buildContextRequest(req.query, {
        podId,
        userId: agentUser._id,
        agentName: installation.agentName,
        instanceId: installation.instanceId || AgentRuntimeRequestService.DEFAULT_INSTANCE_ID,
      }),
    );

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

    if (!AgentRuntimeRequestService.ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const limit = AgentRuntimeRequestService.parseLimit(req.query.limit, 20, 50);
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

    if (!AgentRuntimeRequestService.ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const { content, metadata, messageType } = req.body || {};
    const result = await AgentMessageService.postMessage({
      agentName: installation.agentName,
      instanceId: installation.instanceId || AgentRuntimeRequestService.DEFAULT_INSTANCE_ID,
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

    const post = await AgentRuntimeRequestService.loadThreadPost(threadId);
    if (!post) {
      return res.status(404).json({ message: 'Thread not found' });
    }

    if (post.podId && !AgentRuntimeRequestService.ensurePodMatch(installation, post.podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const result = await AgentThreadService.postComment({
      agentName: installation.agentName,
      instanceId: installation.instanceId || AgentRuntimeRequestService.DEFAULT_INSTANCE_ID,
      displayName: installation.displayName,
      threadId,
      content,
    });

    return res.json(result);
  } catch (error) {
    console.error('Error posting agent thread comment:', error);
    return res.status(500).json({ message: error.message || 'Failed to post comment' });
  }
});

module.exports = router;
