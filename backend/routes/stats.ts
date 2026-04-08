// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Message = require('../models/Message');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/public', async (_req: unknown, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activePods, activeAgents, messageCount24h, registeredUsers] = await Promise.all([
      Pod.countDocuments({ updatedAt: { $gte: sevenDaysAgo } }),
      AgentInstallation.distinct('agentName').then((names: string[]) => names.length),
      Message.countDocuments({ createdAt: { $gte: oneDayAgo } }),
      User.countDocuments(),
    ]);

    res.json({ activePods, activeAgents, messageCount24h, registeredUsers });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;

export {};
