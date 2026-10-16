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

const { VISIT_REFS_PER_DAY, OTHER_REF } = AttributionVisit;

// A ref already counted today keeps its row; a new one gets a row only while the
// day has fewer than VISIT_REFS_PER_DAY, so a script inventing codes fills one
// 'other' row instead of the table. Two first visits racing past the cap can add
// one row each; the cap is a bound on growth, not an exact count.
const bucketFor = async (day: string, ref: string): Promise<string> => {
  if (await AttributionVisit.exists({ day, ref })) return ref;
  const refsToday = await AttributionVisit.countDocuments({ day, ref: { $ne: OTHER_REF } });
  return refsToday < VISIT_REFS_PER_DAY ? ref : OTHER_REF;
};
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
    const day = new Date().toISOString().slice(0, 10);
    await AttributionVisit.updateOne(
      { day, ref: await bucketFor(day, ref) },
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
