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
// eslint-disable-next-line global-require
const { platformIpRateLimit } = require('../middleware/platformRateLimit');

// TASK-108 (triage doc §6): `GET /public` is NOT a probe
// exemption, and the rule is why — "does an anonymous hit do database work".
// This one runs three countDocuments (Mongo) plus a Postgres COUNT per hit,
// uncached, so it takes the IP tier beside the OAuth callback at the same
// 600/60s. The four liveness/meta reads that stay exempt (health.ts ×2,
// pg-status.ts, docs.ts) are exempt for the opposite reason: a limiter on a
// liveness probe can BE the outage.
const statsPublicLimit = platformIpRateLimit({
  windowMs: 60_000,
  limit: 600,
  label: '600 public stats reads per 60s per IP',
});

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

router.get('/public', statsPublicLimit, async (_req: unknown, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }) => {
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
const { markByoCommandCopied, markByoCopyType, markByoSetup, markSurface } = require('../services/onboardingMarks');
// eslint-disable-next-line global-require
const { rateLimit } = require('express-rate-limit');
// eslint-disable-next-line global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../middleware/ipRateLimit');
// eslint-disable-next-line global-require
const { recordByoEvent } = require('../services/byoTelemetry');

const BYO_STEPS = new Set([
  'page-viewed', 'seat-created', 'mcp-command-copied', 'cli-command-copied', 'daemon-command-copied',
  'token-copied', 'listen-confirmed', 'listen-timeout', 'hosted-offer-shown', 'hosted-offer-clicked',
  'invite-card-shown', 'invite-card-dismissed', 'byo-offer-shown',
]);
// Steps that copy a setup command, and the copy types each may carry. A step
// and its type must agree, so "token-copied" can never set the listen mark.
const COPY_TYPES_BY_STEP: Record<string, string[]> = {
  'mcp-command-copied': ['mcp-claude', 'mcp-cursor'],
  'cli-command-copied': ['listen'],
  'daemon-command-copied': ['daemon'],
  'token-copied': ['token'],
};
// Onboarding surfaces: each step also sets its write-once onboarding mark.
const SURFACE_STEPS: Record<string, string> = {
  'invite-card-shown': 'inviteCardShownAt',
  'invite-card-dismissed': 'inviteCardDismissedAt',
  'byo-offer-shown': 'byoOfferShownAt',
};

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
  if (step === 'mcp-command-copied' || step === 'cli-command-copied') {
    // Keep the durable funnel mark small and fixed-enum. Never accept or store
    // the copied command, which contains a runtime token.
    markByoCommandCopied(req.userId, step === 'mcp-command-copied' ? 'mcp' : 'cli');
  }
  const allowedCopyTypes = COPY_TYPES_BY_STEP[step];
  if (allowedCopyTypes && allowedCopyTypes.includes(req.body?.copyType)) {
    markByoCopyType(req.userId, req.body.copyType);
  }
  // The setup the result page showed. The service validates both fields and
  // writes nothing for a missing or malformed value.
  markByoSetup(req.userId, { setupOs: req.body?.setupOs, listenerAvailable: req.body?.listenerAvailable });
  if (SURFACE_STEPS[step]) markSurface(req.userId, SURFACE_STEPS[step]);
  await recordByoEvent(req.userId, step as any, {
    ...(step === 'mcp-command-copied' ? { commandType: 'mcp' } : {}),
    ...(step === 'cli-command-copied' ? { commandType: 'cli' } : {}),
  });
  return res.json({ ok: true });
});

module.exports = router;

export {};
