// Admin activation-funnel analytics (Wave 0 "See & Hear", GH#661).
// Everything is DERIVED from existing collections — no new tracking, no
// third-party analytics, nothing leaves the instance. Human users only
// (bot User rows are excluded by botMetadata.agentName absence).
//
// Honest approximations, documented:
// - "returned D1/D7" uses User.lastActive >= createdAt + 1d/7d — i.e. "was
//   active at some point ≥N days after signup". lastActive only stores the
//   most recent activity, so intermediate visits are invisible; this is a
//   floor-accurate proxy, not an event-grade cohort metric.
// - "sent a message" reads PostgreSQL (the primary message store). The Mongo
//   Message collection is a fallback path and would undercount ~everything.
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

const router = express.Router();

// Read-only admin analytics — generous for a human operator, bounded for
// abuse (CodeQL js/missing-rate-limiting).
const adminReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: (_req: any, res: any) => res.status(429).json({ message: 'rate limit exceeded: 60 analytics reads per 60s' }),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// Distinct PG user_ids with at least one message, within the candidate set.
// Isolated so tests can run without a live PostgreSQL (mocked module).
const pgUserIdsWithMessages = async (userIds: string[]): Promise<Set<string>> => {
  if (userIds.length === 0) return new Set();
  // eslint-disable-next-line global-require
  const { pool } = require('../../config/db-pg');
  const result = await pool.query(
    'SELECT DISTINCT user_id FROM messages WHERE user_id = ANY($1)',
    [userIds],
  );
  return new Set(result.rows.map((r: { user_id: string }) => String(r.user_id)));
};

// GET /api/admin/analytics/funnel?days=30
// Daily signup cohorts with: signups, attached ≥1 agent, sent ≥1 message,
// returned D1/D7 (proxy), plus a totals row with rates.
router.get('/funnel', adminReadLimiter, auth, adminAuth, async (req: any, res: any) => {
  try {
    const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * DAY_MS);

    const users = await User.find({
      createdAt: { $gte: since },
      $or: [
        { botMetadata: { $exists: false } },
        { 'botMetadata.agentName': { $exists: false } },
      ],
    }).select('_id createdAt lastActive').lean();

    const ids = users.map((u: any) => String(u._id));
    const [attachedIds, messagedIds] = await Promise.all([
      AgentInstallation.distinct('installedBy', { installedBy: { $in: ids } })
        .then((list: unknown[]) => new Set(list.map(String))),
      pgUserIdsWithMessages(ids),
    ]);

    const byDay = new Map<string, {
      date: string; signups: number; attachedAgent: number;
      sentMessage: number; returnedD1: number; returnedD7: number;
    }>();
    // Pre-seed every day in range so quiet days render as zeros, not gaps.
    for (let t = since.getTime(); t <= Date.now(); t += DAY_MS) {
      const key = dayKey(new Date(t));
      byDay.set(key, { date: key, signups: 0, attachedAgent: 0, sentMessage: 0, returnedD1: 0, returnedD7: 0 });
    }

    for (const u of users as any[]) {
      const key = dayKey(new Date(u.createdAt));
      const row = byDay.get(key);
      if (!row) continue;
      const id = String(u._id);
      const created = new Date(u.createdAt).getTime();
      const last = u.lastActive ? new Date(u.lastActive).getTime() : created;
      row.signups += 1;
      if (attachedIds.has(id)) row.attachedAgent += 1;
      if (messagedIds.has(id)) row.sentMessage += 1;
      if (last >= created + DAY_MS) row.returnedD1 += 1;
      if (last >= created + 7 * DAY_MS) row.returnedD7 += 1;
    }

    const cohorts = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const totals = cohorts.reduce(
      (acc, r) => ({
        signups: acc.signups + r.signups,
        attachedAgent: acc.attachedAgent + r.attachedAgent,
        sentMessage: acc.sentMessage + r.sentMessage,
        returnedD1: acc.returnedD1 + r.returnedD1,
        returnedD7: acc.returnedD7 + r.returnedD7,
      }),
      { signups: 0, attachedAgent: 0, sentMessage: 0, returnedD1: 0, returnedD7: 0 },
    );
    const rate = (n: number) => (totals.signups ? Math.round((n / totals.signups) * 100) : 0);

    return res.json({
      days,
      since: since.toISOString(),
      cohorts,
      totals: {
        ...totals,
        attachRatePct: rate(totals.attachedAgent),
        messageRatePct: rate(totals.sentMessage),
        d1ReturnPct: rate(totals.returnedD1),
        d7ReturnPct: rate(totals.returnedD7),
      },
      notes: [
        'returnedD1/D7 are lastActive-based proxies (active at some point ≥N days after signup)',
        'sentMessage reads PostgreSQL, the primary message store',
        'bot User rows excluded',
      ],
    });
  } catch (err: any) {
    console.error('Funnel analytics failed:', err.message);
    return res.status(500).json({ message: 'Failed to compute funnel' });
  }
});

module.exports = router;
export {};
