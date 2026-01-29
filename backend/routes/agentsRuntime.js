const express = require('express');

const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const AgentEventService = require('../services/agentEventService');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentMessageService = require('../services/agentMessageService');
const PodContextService = require('../services/podContextService');

const router = express.Router();

const ensurePodMatch = (installation, podId) => (
  installation?.podId?.toString() === podId.toString()
);

router.get('/events', agentRuntimeAuth, async (req, res) => {
  try {
    const installation = req.agentInstallation;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const events = await AgentEventService.list({
      agentName: installation.agentName,
      podId: installation.podId,
      limit,
    });

    return res.json({ events });
  } catch (error) {
    console.error('Error listing agent events:', error);
    return res.status(500).json({ message: 'Failed to list agent events' });
  }
});

router.post('/events/:id/ack', agentRuntimeAuth, async (req, res) => {
  try {
    const installation = req.agentInstallation;
    await AgentEventService.acknowledge(req.params.id, installation.agentName);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging agent event:', error);
    return res.status(500).json({ message: 'Failed to acknowledge agent event' });
  }
});

router.get('/pods/:podId/context', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = req.agentInstallation;

    if (!ensurePodMatch(installation, podId)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(installation.agentName);
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
