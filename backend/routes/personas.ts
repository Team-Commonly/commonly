/**
 * Persona hiring — the where-step's backend (persona plan Phase 2).
 *
 * POST /api/personas/:agentName/hire { podId }
 *
 * Thin over personaHireService: this file owns auth, rate limiting, and the
 * hosted-seat entitlement gate; the service owns identity, idempotency, and
 * the intro. Role and entitlements load from the DB — JWT sessions carry
 * req.user = { id } only (the #1065 lesson, third application).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rateLimit } = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cloudflareIpRateLimitKeyGenerator } = require('../middleware/ipRateLimit');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hirePersona } = require('../services/personaHireService');

const router: ReturnType<typeof express.Router> = express.Router();

router.use(rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: any, res: any) => res.status(429).json({ code: 'rate_limited' }),
}));

router.post('/:agentName/hire', auth, async (req: any, res: any) => {
  try {
    const userId = String(req.userId || '');
    const podId = String(req.body?.podId || '').trim();
    if (!podId) {
      return res.status(400).json({ error: 'podId is required' });
    }

    const caller = await User.findById(userId).select('role entitlements').lean();
    const isAdmin = caller?.role === 'admin';

    // D4: the finite thing is the hosted seat, surfaced at the where-step.
    // Same gate + refusal code as registry install, so the UI's existing
    // BYO-redirect handling works here unchanged.
    if (!isAdmin && caller?.entitlements?.cloudAgents !== true) {
      return res.status(403).json({
        code: 'cloud_agents_not_entitled',
        message: 'Hosted colleagues need a seat — you can connect your own local agent instead.',
      });
    }

    // Membership gate mirrors registry install: you hire into your own rooms.
    const pod = await Pod.findById(podId).select('members createdBy publicRead').lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const isMember = (pod.members || []).some((m: any) => {
      const memberId = m?.userId?.toString?.() || m?.toString?.();
      return memberId === userId;
    });
    const isCreator = pod.createdBy?.toString() === userId;
    if (!isMember && !isCreator) {
      return res.status(403).json({ error: 'You must be a member of this pod' });
    }
    // The 07-24 rule, same as registry install: community pods hire only via
    // their admin.
    if (pod.publicRead === true && !isAdmin && !isCreator) {
      return res.status(403).json({
        code: 'public_pod_requires_admin',
        error: 'This is a community pod — agents install here only by a pod admin.',
      });
    }

    const result = await hirePersona({ agentName: req.params.agentName, userId, podId });
    return res.json({ ok: true, hire: result });
  } catch (err: any) {
    if (err?.code && err?.status) {
      return res.status(err.status).json({ code: err.code, error: err.message });
    }
    console.error('[personas] hire failed:', err);
    return res.status(500).json({ error: 'Failed to hire persona' });
  }
});

module.exports = router;
