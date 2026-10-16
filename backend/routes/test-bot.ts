// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const AgentEventService = require('../services/agentEventService');
// eslint-disable-next-line global-require
const { requireDevRoutes } = require('../config/devRoutes');

interface AuthReq {
  body: { podId?: string; discordSummary?: string; integrationId?: string };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();
// Opt-in only (config/devRoutes), like routes/dev.
router.use(requireDevRoutes);

router.post('/discord-summary', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, discordSummary, integrationId } = req.body;

    if (!podId || !discordSummary) {
      return res.status(400).json({ message: 'podId and discordSummary are required' });
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

    return res.json({
      success: true,
      message: 'Discord summary queued for Commonly Bot',
      data: { eventId: event._id },
    });
  } catch (error) {
    console.error('Error in test Discord summary:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

export {};
