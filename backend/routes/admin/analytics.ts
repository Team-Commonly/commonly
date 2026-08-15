// Admin activation-funnel analytics (Wave 0 "See & Hear", GH#661).
// Everything is DERIVED from existing collections — no new tracking, no
// third-party analytics, nothing leaves the instance. Human users only —
// see HUMAN_FILTER below for what "human" means and why it takes two signals.
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

// Who counts as a human takes TWO signals, and the definition now lives in
// services/userClassification.ts because the onboarding-silence alert needs
// the identical split. It used to be inline here; a second copy of a rule this
// subtle is how it drifts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HUMAN_FILTER, BOT_FILTER } = require('../../services/userClassification');

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
      ...HUMAN_FILTER,
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

// GET /api/admin/analytics/usage?days=30
// Instance-level activity for the admin dashboard: signups/day (Mongo,
// humans), messages/day + distinct human posters/day (PG), rolling DAU/WAU
// cards (lastActive — any authenticated activity, broader than posting).
router.get('/usage', adminReadLimiter, auth, adminAuth, async (req: any, res: any) => {
  try {
    const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * DAY_MS);

    const [signupUsers, botUsers, dau, wau, totalUsers] = await Promise.all([
      User.find({ createdAt: { $gte: since }, ...HUMAN_FILTER }).select('createdAt').lean(),
      User.find(BOT_FILTER).select('_id').lean(),
      User.countDocuments({ lastActive: { $gte: new Date(Date.now() - DAY_MS) }, ...HUMAN_FILTER }),
      User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 7 * DAY_MS) }, ...HUMAN_FILTER }),
      User.countDocuments(HUMAN_FILTER),
    ]);
    const botIds = botUsers.map((u: any) => String(u._id));

    // eslint-disable-next-line global-require
    const { pool } = require('../../config/db-pg');
    const pgDaily = await pool.query(
      `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day,
              COUNT(*)::int AS messages,
              COUNT(DISTINCT user_id) FILTER (WHERE NOT (user_id = ANY($2)))::int AS posters
         FROM messages
        WHERE created_at >= $1
        GROUP BY 1`,
      [since, botIds],
    );

    const byDay = new Map<string, { date: string; signups: number; messages: number; posters: number }>();
    for (let t = since.getTime(); t <= Date.now(); t += DAY_MS) {
      const key = dayKey(new Date(t));
      byDay.set(key, { date: key, signups: 0, messages: 0, posters: 0 });
    }
    for (const u of signupUsers as any[]) {
      const row = byDay.get(dayKey(new Date(u.createdAt)));
      if (row) row.signups += 1;
    }
    for (const r of pgDaily.rows as Array<{ day: string; messages: number; posters: number }>) {
      const row = byDay.get(r.day);
      if (row) {
        row.messages = r.messages;
        row.posters = r.posters;
      }
    }

    const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return res.json({
      days,
      since: since.toISOString(),
      daily,
      totals: {
        signups: signupUsers.length,
        messages: daily.reduce((n, r) => n + r.messages, 0),
        dau,
        wau,
        totalUsers,
      },
      notes: [
        'dau/wau count humans with lastActive in the trailing 24h/7d (any authenticated activity)',
        'messages counts every message (agents included); posters counts distinct human senders',
      ],
    });
  } catch (err: any) {
    console.error('Usage analytics failed:', err.message);
    return res.status(500).json({ message: 'Failed to compute usage' });
  }
});

// GET /api/admin/analytics/lifecycle
// Per-user pod + message counts for the admin user list ("joined 15d ·
// 3 pods · 42 msgs"). Kept out of /api/admin/users on purpose: moderation
// must keep working when PostgreSQL is down, so the frontend merges this in
// as a separate, failure-isolated fetch. Two grouped queries, no N+1.
router.get('/lifecycle', adminReadLimiter, auth, adminAuth, async (_req: any, res: any) => {
  try {
    // eslint-disable-next-line global-require
    const Pod = require('../../models/Pod');
    const [podCounts, pgCounts] = await Promise.all([
      Pod.aggregate([
        { $unwind: '$members' },
        { $group: { _id: '$members', pods: { $sum: 1 } } },
      ]),
      (async () => {
        // eslint-disable-next-line global-require
        const { pool } = require('../../config/db-pg');
        const r = await pool.query('SELECT user_id, COUNT(*)::int AS messages FROM messages GROUP BY user_id');
        return r.rows as Array<{ user_id: string; messages: number }>;
      })(),
    ]);

    const users: Record<string, { pods: number; messages: number }> = {};
    const entry = (id: string) => {
      if (!users[id]) users[id] = { pods: 0, messages: 0 };
      return users[id];
    };
    for (const row of podCounts as Array<{ _id: unknown; pods: number }>) {
      entry(String(row._id)).pods = row.pods;
    }
    for (const row of pgCounts) {
      entry(String(row.user_id)).messages = row.messages;
    }
    return res.json({ users });
  } catch (err: any) {
    console.error('Lifecycle analytics failed:', err.message);
    return res.status(500).json({ message: 'Failed to compute lifecycle stats' });
  }
});

// GET /api/admin/analytics/silence?days=14
// Newcomers who typed into a room that could have answered, and got nothing.
//
// The cron alert (services/onboardingAlertService.ts) pushes; this pulls. Both
// exist because they fail differently: email needs configuration and can
// bounce, and an alert you can only receive is one you cannot go back and
// check. This endpoint is also what makes "did the fix work" answerable
// without re-reading production transcripts by hand.
router.get('/silence', adminReadLimiter, auth, adminAuth, async (req: any, res: any) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 14));
    const since = new Date(Date.now() - days * DAY_MS);
    // eslint-disable-next-line global-require
    const OnboardingSilenceEpisode = require('../../models/OnboardingSilenceEpisode');
    // eslint-disable-next-line global-require
    const { SILENCE_THRESHOLD_MINUTES } = require('../../services/onboardingSilenceService');
    // eslint-disable-next-line global-require
    const { diagnose } = require('../../services/onboardingAlertService');

    const episodes = await OnboardingSilenceEpisode.find({ detectedAt: { $gte: since } })
      .sort({ detectedAt: -1 }).limit(500).lean();

    const shaped = episodes.map((e: any) => ({
      id: String(e._id),
      user: e.username || String(e.userId),
      userId: String(e.userId),
      pod: e.podName || e.podId,
      podId: e.podId,
      firstTypedAt: e.firstTypedAt,
      accountAgeMinutes: e.accountAgeMinutes,
      messageCount: e.messageCount,
      status: e.status,
      outcome: e.outcome || null,
      resolutionLagSeconds: e.resolutionLagSeconds ?? null,
      alerted: Boolean(e.alertSentAt),
      collapsedIntoRollup: Boolean(e.collapsedIntoRollup),
      diagnosis: diagnose({
        firstTypedAt: e.firstTypedAt, eventSnapshot: e.eventSnapshot,
      } as any),
      eventSnapshot: e.eventSnapshot || null,
    }));

    const open = shaped.filter((e: any) => e.status === 'open');
    const byDiagnosis: Record<string, number> = {};
    for (const e of shaped) byDiagnosis[e.diagnosis] = (byDiagnosis[e.diagnosis] || 0) + 1;

    return res.json({
      days,
      since: since.toISOString(),
      thresholdMinutes: SILENCE_THRESHOLD_MINUTES,
      alertRecipientConfigured: Boolean((process.env.ONBOARDING_ALERT_EMAIL || '').trim()),
      totals: {
        episodes: shaped.length,
        open: open.length,
        resolved: shaped.length - open.length,
        humanRescued: shaped.filter((e: any) => e.outcome === 'human-rescued').length,
        byDiagnosis,
      },
      episodes: shaped,
      notes: [
        'an episode is one (user, pod) run of silence, not one message',
        'only a bot author counts as a reply; a human answering is recorded as human-rescued',
        'pods without an active AgentInstallation are never counted — nothing there could answer',
        'diagnosis is only meaningful when captured at fire time; agent events are GC-ed at 30 min',
      ],
    });
  } catch (err: any) {
    console.error('Silence analytics failed:', err.message);
    return res.status(500).json({ message: 'Failed to compute silence episodes' });
  }
});

module.exports = router;
export {};
