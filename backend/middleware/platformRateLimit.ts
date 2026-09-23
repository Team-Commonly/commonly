import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { cloudflareIpRateLimitKeyGenerator } from './ipRateLimit';

/**
 * The IP-tier limiter for the public/anon surface (TASK-108, ruling wren 71373
 * "(D), split" — this is the (B) half; (A) mount-level on /api/agents/runtime
 * is Sam's order and is not this file).
 *
 * WHO GETS THE IP TIER, AND WHY. This is the tier for routes where there is no
 * token to key on, or where a token key would answer the wrong question
 * (wren 71374): pre-auth reads (`/auth/registration-policy`,
 * `/auth/verify-email`), third-party redirect and callback targets
 * (`x/oauth/callback`, `discord /callback`, `billing POST /webhook`), and the
 * long-poll reads (`/events`, `/bot/events`) — a retry storm from a third party
 * is still an IP, and a long-poll's request count is not a per-token budget
 * question.
 *
 * THE KEY IS THE SAME ONE THE OTHER IP TIER USES. Not `req.ip`, and not a
 * fresh copy of the logic: `cloudflareIpRateLimitKeyGenerator` is the generator
 * TASK-110 keyed the rest of the fleet on, and a second implementation here
 * would be a second answer to "who is this caller". That generator's own doc
 * carries the two assumptions it rests on and the no-tunnel case (TASK-120).
 *
 * THE 429 BODY NAMES THE PLATFORM, AND THAT IS THE POINT. The body carries
 * `status` and a named `reason` so a reader can classify it — the shape the
 * triage doc's §6 asks for. `platform_rate_limited` is deliberately NOT one of
 * the kernel's refusal classes (`upstream-refused`, `cascade-cap`,
 * `delivery-refused`, mirrored in `cli/src/lib/claim-outcome.js`): a 429 the
 * PLATFORM issued and a 429 a model provider issued are different facts, and
 * dressing this one as `upstream-refused` would record our own budget as the
 * provider's outage. A seat that cannot classify the name falls back to
 * `delivery-refused` — the class that claims the least — which is the correct
 * handling of an unknown refusal, not a silent success.
 *
 * `code: 'rate_limited'` is kept because the existing limiters already emit it
 * and a reader written against them must not start failing to find it.
 *
 * BUDGETS ARE PER-ROUTE AND DECLARED AT THE ROUTE, not here: they are
 * threat-model numbers (vera 71390 — the ingress log holds zero hits on two of
 * these routes, so nothing fits them to traffic), and a route reader should
 * meet its own number beside the route rather than in a table elsewhere.
 */
export const PLATFORM_RATE_LIMIT_REASON = 'platform_rate_limited';

export const platformIpRateLimit = ({
  windowMs,
  limit,
  label,
}: {
  windowMs: number;
  limit: number;
  label: string;
}) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: Request, res: Response) => res.status(429).json({
    status: 429,
    reason: PLATFORM_RATE_LIMIT_REASON,
    code: 'rate_limited',
    message: `rate limit exceeded: ${label}`,
  }),
});

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { platformIpRateLimit, PLATFORM_RATE_LIMIT_REASON };
