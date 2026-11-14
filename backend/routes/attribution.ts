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

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const LandingVisit = require('../models/LandingVisit');

const { VISIT_REFS_PER_DAY, OTHER_REF } = AttributionVisit;
const { LANDING_ROWS_PER_DAY } = LandingVisit;

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

// POST /api/attribution/landing { ref?, referrer? }: one landing on a public
// page, counted per UTC day by (ref, referrer site). public/signup-source.js
// sends it once per tab, with or without a ref. The referrer is a bare
// hostname; a leading www. is dropped so x.com and www.x.com share a row.
// A landing from our own site is a click inside it, not a landing, so it is not
// counted. Anything that isn't a plain ref or hostname counts as OTHER, and so
// does an IP address (last label all digits): the table holds no IP of anyone.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;
const OUR_SITE = /(^|\.)commonly\.me$|^localhost$/;
// The sites a launch read asks about. A pair of one of these with no ref or a
// listed campaign ref always keeps its own row, so junk that fills the day's
// cap can't push x.com into OTHER (the same guarantee bucketFor gives campaign
// codes). Bounded: KNOWN_REFERRERS x (campaign list + 1) rows a day.
const KNOWN_REFERRERS = [
  'x.com', 't.co', 'twitter.com', 'news.ycombinator.com', 'producthunt.com', 'github.com',
  'linkedin.com', 'lnkd.in', 'reddit.com', 'google.com', 'bing.com', 'duckduckgo.com',
  'chatgpt.com', 'perplexity.ai', 'devhunt.org', 'alternativeto.net', 'opensourcealternatives.to',
];

const landingPart = (raw: unknown, clean: (s: string) => string | undefined): string => {
  if (raw === undefined || raw === null || raw === '') return LandingVisit.NONE;
  return (typeof raw === 'string' && clean(raw)) || LandingVisit.OTHER;
};
const cleanHost = (raw: string): string | undefined => {
  const host = raw.trim().toLowerCase().replace(/^www\./, '');
  if (host.length > 253 || !HOSTNAME.test(host) || /\.\d+$/.test(host)) return undefined;
  return host;
};

// The same day-first shape as bucketFor, over (ref, referrer) pairs. Protected
// pairs neither compete for the cap nor count against it.
const landingBucket = async (day: string, ref: string, referrer: string) => {
  const protectedRefs = [LandingVisit.NONE, ...(await campaignRefs())];
  if (KNOWN_REFERRERS.includes(referrer) && protectedRefs.includes(ref)) return { ref, referrer };
  if (await LandingVisit.exists({ day, ref, referrer })) return { ref, referrer };
  const rowsToday = await LandingVisit.countDocuments({
    day,
    $nor: [
      { ref: LandingVisit.OTHER, referrer: LandingVisit.OTHER },
      { referrer: { $in: KNOWN_REFERRERS }, ref: { $in: protectedRefs } },
    ],
  });
  if (rowsToday < LANDING_ROWS_PER_DAY) return { ref, referrer };
  return { ref: LandingVisit.OTHER, referrer: LandingVisit.OTHER };
};

// Its own budget: a first arrival with a ref sends both /visit and /landing,
// and sharing one limiter would halve /visit's room behind a shared NAT.
const landingRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: (_req: any, res: any) => res.status(429).json({ msg: 'rate limit exceeded: 10 landings per 60s' }),
});

router.post('/attribution/landing', landingRateLimit, async (req: any, res: any) => {
  const ref = landingPart(req.body?.ref, cleanSignupRef);
  const rawReferrer = req.body?.referrer;
  const fromUs = typeof rawReferrer === 'string' && OUR_SITE.test(rawReferrer.trim().toLowerCase());
  if (fromUs) return res.status(204).end();
  const referrer = landingPart(rawReferrer, cleanHost);
  try {
    const day = new Date().toISOString().slice(0, 10);
    await LandingVisit.updateOne(
      { day, ...(await landingBucket(day, ref, referrer)) },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (error) {
    console.warn('[attribution] landing count failed:', (error as Error).message);
  }
  return res.status(204).end();
});

module.exports = router;

export {};
