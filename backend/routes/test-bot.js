const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const AgentEventService = require('../services/agentEventService');

/**
 * Test route for Commonly Bot event queue
 * Only available in development
 */

// Test Discord summary posting
router.post('/discord-summary', auth, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' });
  }

  try {
    const { podId, discordSummary, integrationId } = req.body;

    if (!podId || !discordSummary) {
      return res
        .status(400)
        .json({ message: 'podId and discordSummary are required' });
    }

    const event = await AgentEventService.enqueue({
      agentName: 'commonly-bot',
      podId,
      type: 'discord.summary',
      payload: {
        summary: discordSummary,
        integrationId: integrationId || 'test-integration',
        source: 'discord',
      },
    });

    res.json({
      success: true,
      message: 'Discord summary queued for Commonly Bot',
      data: {
        eventId: event._id,
      },
    });
  } catch (error) {
    console.error('Error in test Discord summary:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
