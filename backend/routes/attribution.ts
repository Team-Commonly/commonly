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

// A ref counted on ANY day still in the table keeps its own row; a new one gets
// a row only while today has fewer than VISIT_REFS_PER_DAY refs, so a script
// inventing codes fills the overflow row instead of the table. Known refs are
// checked across days (sprint-review on #2282): with a same-day check, about
// five minutes of junk from one address spent the day's slots and pushed every
// real campaign link into the overflow, silently, until midnight UTC.
// The cap is a bound on growth, not an exact count: the check and the write
// are two steps, so a burst of new refs at the crossing overshoots it (1000
// concurrent new refs at 49 rows gave about 1045, Cofounder's measure). That is
// once a day per burst, and the table stays bounded by the TTL.
const bucketFor = async (day: string, ref: string): Promise<string> => {
  if (await AttributionVisit.exists({ ref })) return ref;
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
