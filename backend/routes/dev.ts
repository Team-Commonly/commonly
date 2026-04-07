// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const axios = require('axios');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const { EMBEDDING_CONFIG } = require('../services/vectorSearchService');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const AgentEventService = require('../services/agentEventService');

interface AuthReq {
  user?: { id?: string; _id?: unknown };
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const getLiteLLMConfig = (): { baseUrl: string; apiKey: string | undefined; model: string } | null => {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model: process.env.LITELLM_CHAT_MODEL || 'gemini-2.5-flash',
  };
};

const isMember = (pod: { members?: unknown[] }, userId: unknown): boolean => (
  pod.members?.some((member) => {
    if (!member) return false;
    if ((member as { userId?: unknown }).userId) return (member as { userId: { toString: () => string } }).userId.toString() === String(userId);
    return (member as { toString: () => string }).toString() === String(userId);
  }) || false
);

router.get('/llm/status', auth, async (req: AuthReq, res: Res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Dev endpoints not available in production' });
    }

    const liteConfig = getLiteLLMConfig();
    const litellmStatus: Record<string, unknown> = {
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
          headers: { Authorization: `Bearer ${liteConfig.apiKey}` },
          timeout: 4000,
        });
        litellmStatus.ok = true;
        litellmStatus.models = response.data?.data || response.data?.models || [];
      } catch (error) {
        const e = error as { response?: { data?: { error?: string } }; message?: string };
        litellmStatus.error = e.response?.data?.error || e.message;
      }
    } else if (liteConfig?.baseUrl && !liteConfig?.apiKey) {
      litellmStatus.error = 'LiteLLM API key is missing';
    }

    return res.json({ litellm: litellmStatus, gemini: { enabled: Boolean(process.env.GEMINI_API_KEY) } });
  } catch (error) {
    console.error('Error getting LLM status:', error);
    return res.status(500).json({ error: 'Failed to fetch LLM status' });
  }
});

router.post('/agents/events', auth, async (req: AuthReq, res: Res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Dev endpoints not available in production' });
    }

    const { podId, agentName, type, payload } = (req.body || {}) as { podId?: string; agentName?: string; type?: string; payload?: unknown };
    if (!podId || !agentName || !type) {
      return res.status(400).json({ error: 'podId, agentName, and type are required' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (!isMember(pod, req.user?._id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const event = await AgentEventService.enqueue({ agentName, podId, type, payload: payload || {} });
    return res.json({ success: true, eventId: event._id });
  } catch (error) {
    console.error('Error enqueuing dev agent event:', error);
    return res.status(500).json({ error: 'Failed to enqueue agent event' });
  }
});

module.exports = router;
