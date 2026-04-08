// @ts-nocheck
/**
 * Moltbot Provider Routes
 *
 * API endpoints for managing moltbot integration with Commonly.
 */

const express = require('express');

const router = express.Router();
const auth = require('../../middleware/auth');
const { getMoltbotProvider, ProviderManifest } = require('../../providers/moltbot');

/**
 * GET /api/providers/moltbot
 * Get moltbot provider info and connection status
 */
router.get('/', auth, async (req, res) => {
  try {
    const provider = getMoltbotProvider();
    const connected = provider?.connection?.connected || false;

    res.json({
      manifest: ProviderManifest,
      connected,
      defaultPodId: provider?.defaultPodId,
    });
  } catch (error) {
    console.error('Error getting moltbot status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/providers/moltbot/connect
 * Connect to moltbot Gateway
 */
router.post('/connect', auth, async (req, res) => {
  try {
    const { gatewayUrl, apiToken, defaultPodId } = req.body;

    const provider = getMoltbotProvider({
      gatewayUrl,
      apiToken: apiToken || req.headers.authorization?.replace('Bearer ', ''),
      defaultPodId,
    });

    await provider.initialize();

    res.json({
      success: true,
      message: 'Connected to moltbot Gateway',
    });
  } catch (error) {
    console.error('Error connecting to moltbot:', error);
    res.status(500).json({
      error: 'Failed to connect to moltbot Gateway',
      details: error.message,
    });
  }
});

/**
 * POST /api/providers/moltbot/disconnect
 * Disconnect from moltbot Gateway
 */
router.post('/disconnect', auth, async (req, res) => {
  try {
    const provider = getMoltbotProvider();
    if (provider) {
      provider.shutdown();
    }

    res.json({
      success: true,
      message: 'Disconnected from moltbot Gateway',
    });
  } catch (error) {
    console.error('Error disconnecting from moltbot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/providers/moltbot/push
 * Push an event to moltbot
 */
router.post('/push', auth, async (req, res) => {
  try {
    const { eventType, payload } = req.body;

    if (!eventType) {
      return res.status(400).json({ error: 'eventType is required' });
    }

    const provider = getMoltbotProvider();
    if (!provider || !provider.connection?.connected) {
      return res.status(503).json({ error: 'Not connected to moltbot' });
    }

    provider.pushEvent(eventType, payload);

    res.json({ success: true });
  } catch (error) {
    console.error('Error pushing event to moltbot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/providers/moltbot/context/:podId
 * Get context for moltbot from a pod
 */
router.get('/context/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { task } = req.query;

    const provider = getMoltbotProvider();
    if (!provider) {
      return res.status(503).json({ error: 'Moltbot provider not initialized' });
    }

    const context = await provider.getContext(podId, { task });
    res.json(context);
  } catch (error) {
    console.error('Error getting context for moltbot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/providers/moltbot/search/:podId
 * Search pod memory for moltbot
 */
router.post('/search/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { query, limit, types } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const provider = getMoltbotProvider();
    if (!provider) {
      return res.status(503).json({ error: 'Moltbot provider not initialized' });
    }

    const results = await provider.search(podId, query, { limit, types });
    res.json(results);
  } catch (error) {
    console.error('Error searching for moltbot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/providers/moltbot/write/:podId
 * Write to pod memory from moltbot
 */
router.post('/write/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { target, content, tags } = req.body;

    if (!target || !content) {
      return res.status(400).json({ error: 'target and content are required' });
    }

    const provider = getMoltbotProvider();
    if (!provider) {
      return res.status(503).json({ error: 'Moltbot provider not initialized' });
    }

    const result = await provider.write(podId, { target, content, tags });
    res.json(result);
  } catch (error) {
    console.error('Error writing for moltbot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
