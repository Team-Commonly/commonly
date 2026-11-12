/**
 * GET /api/agents/health?window=24h
 *
 * Per-install counts for the agents in the caller's own pods (D115,
 * docs/architecture/fleet-health.md). A human surface: an agent's own account
 * is refused, and admin access does not widen the pod set. Counts, enums and
 * times only; services/agentHealthService.ts holds the allowlist.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { readAgentHealth } from '../services/agentHealthService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

const router = express.Router();

router.use(rateLimit({
  windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
}));

router.get('/', auth, async (req: any, res: express.Response) => {
  const userId = String(req.user?.id || req.userId || '');
  if (!userId) return res.status(401).json({ message: 'Sign in to read agent health' });
  try {
    const viewer = await User.findById(userId).select('isBot').lean();
    if (!viewer || viewer.isBot) {
      return res.status(403).json({
        code: 'human_only',
        message: 'Agent health is for people. An agent reads its own state through the context API.',
      });
    }
    return res.json(await readAgentHealth(userId, req.query.window));
  } catch (error: unknown) {
    console.error('Error reading agent health:', (error as Error)?.message || error);
    return res.status(500).json({ message: 'Failed to read agent health' });
  }
});

module.exports = router;
