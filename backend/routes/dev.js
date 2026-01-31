const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');
const { EMBEDDING_CONFIG } = require('../services/vectorSearchService');
const Pod = require('../models/Pod');
const AgentEventService = require('../services/agentEventService');

const router = express.Router();

const getLiteLLMConfig = () => {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model: process.env.LITELLM_CHAT_MODEL || 'gemini-2.0-flash',
  };
};

const isMember = (pod, userId) => (
  pod.members?.some((member) => {
    if (!member) return false;
    if (member.userId) return member.userId.toString() === userId.toString();
    return member.toString() === userId.toString();
  })
);

/**
 * GET /api/dev/llm/status
 * Development-only LLM gateway status
 */
router.get('/llm/status', auth, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Dev endpoints not available in production' });
    }

    const liteConfig = getLiteLLMConfig();
    const litellmStatus = {
      enabled: Boolean(liteConfig?.baseUrl),
      baseUrl: liteConfig?.baseUrl || null,
      model: liteConfig?.model || null,
      embeddingProvider: EMBEDDING_CONFIG.provider,
      embeddingModel: EMBEDDING_CONFIG.model,
      embeddingDimensions: EMBEDDING_CONFIG.dimensions,
      ok: false,
      models: [],
      error: null,
    };

    if (liteConfig?.baseUrl && liteConfig?.apiKey) {
      try {
        const response = await axios.get(`${liteConfig.baseUrl}/models`, {
          headers: {
            Authorization: `Bearer ${liteConfig.apiKey}`,
          },
          timeout: 4000,
        });
        litellmStatus.ok = true;
        litellmStatus.models = response.data?.data || response.data?.models || [];
      } catch (error) {
        litellmStatus.error = error.response?.data?.error || error.message;
      }
    } else if (liteConfig?.baseUrl && !liteConfig?.apiKey) {
      litellmStatus.error = 'LiteLLM API key is missing';
    }

    return res.json({
      litellm: litellmStatus,
      gemini: {
        enabled: Boolean(process.env.GEMINI_API_KEY),
      },
    });
  } catch (error) {
    console.error('Error getting LLM status:', error);
    return res.status(500).json({ error: 'Failed to fetch LLM status' });
  }
});

/**
 * POST /api/dev/agents/events
 * Development-only helper to enqueue a test agent event
 */
router.post('/agents/events', auth, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Dev endpoints not available in production' });
    }

    const { podId, agentName, type, payload } = req.body || {};
    if (!podId || !agentName || !type) {
      return res.status(400).json({ error: 'podId, agentName, and type are required' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (!isMember(pod, req.user._id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const event = await AgentEventService.enqueue({
      agentName,
      podId,
      type,
      payload: payload || {},
    });

    return res.json({ success: true, eventId: event._id });
  } catch (error) {
    console.error('Error enqueuing dev agent event:', error);
    return res.status(500).json({ error: 'Failed to enqueue agent event' });
  }
});

module.exports = router;
