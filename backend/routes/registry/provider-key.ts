import express from 'express';
import rateLimit from 'express-rate-limit';
import { manageProviderKey } from '../../services/agentProviderKey';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
const auth = require('../../middleware/auth');
const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => cloudflareIpRateLimitKeyGenerator(req as never) });
router.all('/agents/:name/provider-key', limiter, auth, async (req, res) => {
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return res.sendStatus(405);
  try { return await manageProviderKey(req, res); } catch {
    // Provider material and ring errors must never enter request error logs.
    return res.status(503).json({ code: 'provider_key_unavailable' });
  }
});
module.exports = router;
