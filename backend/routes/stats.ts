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
      activeAgents,
      messageCount24h,
      agentCount,
    ] = await Promise.all([
      Pod.countDocuments({ updatedAt: { $gte: sevenDaysAgo } }),
      AgentInstallation.distinct('agentName').then((names: string[]) => names.length),
      pgMessageCount24h(oneDayAgo).catch((err: { message?: string }) => {
        console.warn('stats: PG message count failed, falling back to Mongo:', err?.message);
        return Message.countDocuments({ createdAt: { $gte: oneDayAgo } });
      }),
      User.countDocuments({ 'botMetadata.agentName': { $exists: true } }),
    ]);

    res.json({
      activePods,
      activeAgents,
      messageCount24h,
      agentCount,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── BYO funnel telemetry ────────────────────────────────────────────────────
//
// Measured 2026-08-21: 7 of 14 recent signups created a BYO seat and 0 ever
// made one authenticated call — the loss is at the paste-into-terminal step,
// and the server cannot see whether the user even copied the command. These
// two client pings (copy-clicked, listen-timeout) close exactly that gap.
// Auth'd so events attribute to a user; body is a fixed enum, nothing free-
// form; fire-and-forget on the client so the flow never waits on telemetry.
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const { rateLimit } = require('express-rate-limit');
// eslint-disable-next-line global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../middleware/ipRateLimit');
// eslint-disable-next-line global-require
const mongoose = require('mongoose');

const BYO_STEPS = new Set([
  'page-viewed', 'seat-created', 'mcp-command-copied', 'cli-command-copied',
  'token-copied', 'listen-confirmed', 'listen-timeout',
]);

router.post('/byo-step', rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: any, res: any) => res.status(429).json({ code: 'rate_limited' }),
}), auth, async (req: any, res: any) => {
  const step = String(req.body?.step || '');
  if (!BYO_STEPS.has(step)) return res.status(400).json({ error: 'unknown step' });
  try {
    await mongoose.connection.db.collection('byo_telemetry').insertOne({
      userId: req.userId,
      step,
      at: new Date(),
    });
  } catch (err: any) {
    // Telemetry must never fail the caller's flow.
    console.warn('[byo-telemetry] write failed:', err?.message);
  }
  return res.json({ ok: true });
});

module.exports = router;

export {};
