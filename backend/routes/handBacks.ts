/**
 * ADR-037 (F654) hand-back routes outside the CAP runtime surface.
 *
 * - `router` (mounted at /api/hand-backs): POST /:id/withdraw, `dualAuth`.
 *   The author agent's runtime token, or a person who owns that agent.
 * - `podRouter` (mounted at /api/pods, before podRoutes' catch-all):
 *   GET /:podId/hand-backs, a person's read of a pod's records, gated by
 *   DMService.canViewPod. Agents read through GET /api/agents/runtime/hand-backs/:id.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const dualAuth = require('../middleware/dualAuth');
const auth = require('../middleware/auth');
const { ensurePodMatch } = require('../services/agentPodScope');
const HandBackService = require('../services/handBackService');
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

const router = express.Router();
const podRouter = express.Router();
// Ahead of auth, so the credential lookup is limited too (routeRateLimitGuard).
const handBackRateLimit = rateLimit({
  windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
});

const OBJECT_ID = /^[a-f0-9]{24}$/i;

const refuse = (res: express.Response, error: any, label: string) => {
  if (error instanceof HandBackService.HandBackError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...(error.detail || {}) });
  }
  if (error?.code === 'hand_back_store_unavailable') {
    return res.status(503).json({ error: 'Hand-backs need PostgreSQL', code: error.code });
  }
  console.error(`[hand-back] ${label} failed:`, (error as Error)?.message);
  return res.status(500).json({ error: 'Failed to process the hand-back' });
};

router.post('/:id/withdraw', handBackRateLimit, dualAuth, async (req: any, res: express.Response) => {
  try {
    const { reason } = req.body || {};
    const caller = req.agentUser?._id
      ? {
        kind: 'agent' as const,
        agentUserId: String(req.agentUser._id),
        authorizedPod: (podId: string) => ensurePodMatch(
          req.agentInstallations || req.agentInstallation, podId, req.agentAuthorizedPodIds,
        ),
      }
      : { kind: 'human' as const, userId: String(req.userId || req.user?.id || '') };
    if (caller.kind === 'human' && !caller.userId) return res.status(401).json({ error: 'Not signed in' });
    const result = await HandBackService.withdraw({ id: String(req.params.id || ''), caller, reason });
    return res.json(result);
  } catch (error) {
    return refuse(res, error, 'withdraw');
  }
});

podRouter.get('/:podId/hand-backs', handBackRateLimit, auth, async (req: any, res: express.Response) => {
  try {
    const { podId } = req.params;
    if (!OBJECT_ID.test(String(podId))) return res.status(404).json({ error: 'Pod not found', code: 'pod_not_found' });
    // ?ids=a,b: the records behind cards past the newest page (V2Thread).
    const ids = typeof req.query.ids === 'string'
      ? req.query.ids.split(',').map((id: string) => id.trim()).filter(Boolean).slice(0, 100)
      : undefined;
    const result = await HandBackService.listForPod(String(podId), String(req.userId || req.user?.id || ''), ids);
    return res.json(result);
  } catch (error) {
    return refuse(res, error, 'pod list');
  }
});

export default router;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = router;
module.exports.podHandBacksRouter = podRouter;
