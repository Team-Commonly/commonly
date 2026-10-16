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
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { campaignRefs } = require('../services/attributionCampaignRefs');

const { VISIT_REFS_PER_DAY, OTHER_REF } = AttributionVisit;

// A listed campaign code (services/attributionCampaignRefs.ts) always keeps its
// own row, so junk can never push a real campaign link into the overflow.
// Every query here filters on day first ({day, ref} index): a query on ref
// alone scans the whole table (114 ms per visit at 501k rows, Cofounder's
// measure on the cross-day rule this replaced).

// Every other ref competes for VISIT_REFS_PER_DAY rows a UTC day, counted afresh
// each day: a ref already counted today keeps its row, a new one gets a row only
// while the day has room, and the rest share the overflow row. So rows per day
// are at most the campaign list + VISIT_REFS_PER_DAY + 1. (A cross-day "known
// ref" rule, tried in #2283, let junk admitted once bypass the cap on every
// later day; Cofounder chose the list instead.) The cap bounds growth, it is not
// an exact count: the check and the write are two steps, so a burst of new refs
// at the crossing overshoots it (1000 concurrent new refs at 49 rows gave about
// 1045, Cofounder's measure), once a day per burst.
const bucketFor = async (day: string, ref: string): Promise<string> => {
  const campaigns = await campaignRefs();
  if (campaigns.has(ref)) return ref;
  if (await AttributionVisit.exists({ day, ref })) return ref;
  const refsToday = await AttributionVisit.countDocuments({ day, ref: { $nin: [...campaigns, OTHER_REF] } });
  return refsToday < VISIT_REFS_PER_DAY ? ref : OTHER_REF;
};

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
