// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Message = require('../models/Message');
const router: ReturnType<typeof express.Router> = express.Router();

const pgMessageCount24h = async (since: Date): Promise<number> => {
  // eslint-disable-next-line global-require
  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM messages WHERE created_at >= $1',
    [since],
  );
  return result.rows[0].count;
};

router.get('/public', async (_req: unknown, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      activePods,
      messageCount24h,
      agents,
    ] = await Promise.all([
      Pod.countDocuments({ updatedAt: { $gte: sevenDaysAgo } }),
      pgMessageCount24h(oneDayAgo).catch((err: { message?: string }) => {
        console.warn('stats: PG message count failed, falling back to Mongo:', err?.message);
        return Message.countDocuments({ createdAt: { $gte: oneDayAgo } });
      }),
      User.countDocuments({ 'botMetadata.agentName': { $exists: true } }),
    ]);

    res.json({
      activePods,
      messageCount24h,
      agents,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;

export {};
