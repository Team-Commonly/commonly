// POST /api/attribution/visit { ref }: one first-touch arrival with a ref code
// (?ref=x on any page), counted per UTC day. A browser sends it once, the first
// time it arrives with a ref (frontend/src/v2/utils/firstTouch.ts), so a crawler
// that runs no JavaScript never counts. Signups carry the same ref on the user
// (onboarding.signupRef); this is the visit side of that funnel.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const AttributionVisit = require('../models/AttributionVisit');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { cleanSignupRef } = require('../utils/signupRef');

const router = express.Router();

const visitRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: (_req: any, res: any) => res.status(429).json({ msg: 'rate limit exceeded: 10 visits per 60s' }),
});

router.post('/attribution/visit', visitRateLimit, async (req: any, res: any) => {
  const ref = cleanSignupRef(req.body?.ref);
  if (!ref) return res.status(204).end();
  try {
    await AttributionVisit.updateOne(
      { day: new Date().toISOString().slice(0, 10), ref },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (error) {
    // A lost count is not worth a visitor's error.
    console.warn('[attribution] visit count failed:', (error as Error).message);
  }
  return res.status(204).end();
});

module.exports = router;

export {};
