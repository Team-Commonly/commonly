import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { cloudflareIpRateLimitKeyGenerator } from './ipRateLimit';

type RateLimitRequest = {
  get?: (header: string) => string | undefined;
  ip?: string;
  headers?: Request['headers'];
};

// Connector writes can mint bearer connect codes. Keep the key and limits in
// one module so every route that creates or re-mints a connector shares the
// same bucket instead of each route being independently burstable.
//
// The key is taken before any route's auth check runs, so the token branch
// buckets by the PRESENTED credential: two requests carrying the same header
// share a bucket whether or not that header authenticates anything. The
// credential is the token `auth` extracts (`auth.ts:34-35`): `Authorization`
// without its `Bearer ` prefix, else `x-auth-token`. Hash a raw header instead
// and one token sent three ways (`Bearer t`, bare `t`, `x-auth-token: t`) holds
// three budgets; read `Authorization` alone and an `x-auth-token` caller shares
// its address's budget with every caller behind that address.
// The no-header branch defers to `cloudflareIpRateLimitKeyGenerator`, which owns the
// `cf-connecting-ip`-then-`req.ip` rule (`ipRateLimit.ts:49`) — read on its own
// here, `req.ip` is a cloudflared pod address for every external caller, so this
// branch was one instance-wide bucket (`server.ts:94-101`, TASK-110's class).
export const integrationsRateLimitKey = (req: RateLimitRequest): string => {
  const credential = req.get?.('authorization')?.replace('Bearer ', '')
    || req.get?.('x-auth-token');
  if (credential) {
    return `tok:${createHash('sha256').update(credential).digest('hex').slice(0, 16)}`;
  }
  // Structural type → the helper's express `Request`: this module keeps its own
  // type so the key stays unit-testable without an express request.
  return cloudflareIpRateLimitKeyGenerator(req as unknown as Request);
};

export const writeIntegrationsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: integrationsRateLimitKey,
  handler: (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 30 writes per 60s' });
  },
});

export const listIntegrationsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: integrationsRateLimitKey,
  handler: (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 120 reads per 60s' });
  },
});

// `POST /ingest` is the provider-service push path. Its credential may also
// arrive as `x-commonly-integration-token` (routes/integrations.ts
// extractToken), which the shared key does not read, so that form would
// otherwise fall back to the caller's address bucket.
export const ingestRateLimitKey = (req: RateLimitRequest): string => {
  const ingestToken = req.get?.('x-commonly-integration-token');
  if (ingestToken) {
    return `int:${createHash('sha256').update(ingestToken).digest('hex').slice(0, 16)}`;
  }
  return integrationsRateLimitKey(req);
};

// The key above is taken before the token is checked, so a caller rotating
// junk credentials gets a fresh bucket per request. This address ceiling sits
// in front of it and bounds that, at a budget a provider service will not hit.
export const ingestIngressRateLimit = rateLimit({
  windowMs: 60_000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: RateLimitRequest) => cloudflareIpRateLimitKeyGenerator(req as unknown as Request),
  handler: (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 1200 ingest requests per 60s' });
  },
});

export const ingestIntegrationsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ingestRateLimitKey,
  handler: (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 300 ingest requests per 60s' });
  },
});

module.exports = {
  integrationsRateLimitKey,
  ingestRateLimitKey,
  writeIntegrationsRateLimit,
  listIntegrationsRateLimit,
  ingestIngressRateLimit,
  ingestIntegrationsRateLimit,
};
