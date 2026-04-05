const express = require('express');

const router = express.Router();
const Pod = require('../models/Pod');
const User = require('../models/User');
const Message = require('../models/Message');
const { AgentInstallation } = require('../models/AgentRegistry');

/**
 * GET /api/stats/public
 * Public metrics endpoint — no auth required.
 * Used by the landing page and YC demo.
 */
router.get('/public', async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activePods, activeAgents, messageCount24h, registeredUsers] = await Promise.all([
      Pod.countDocuments({ updatedAt: { $gte: sevenDaysAgo } }),
      AgentInstallation.distinct('agentName').then((names) => names.length),
      Message.countDocuments({ createdAt: { $gte: oneDayAgo } }),
      User.countDocuments(),
    ]);

    res.json({ activePods, activeAgents, messageCount24h, registeredUsers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
