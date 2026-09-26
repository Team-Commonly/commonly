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
// no-header branch defers to `cloudflareIpRateLimitKeyGenerator`, which owns the
// `cf-connecting-ip`-then-`req.ip` rule (`ipRateLimit.ts:49`) — read on its own
// here, `req.ip` is a cloudflared pod address for every external caller, so this
// branch was one instance-wide bucket (`server.ts:94-101`, TASK-110's class).
export const integrationsRateLimitKey = (req: RateLimitRequest): string => {
  const authHeader = req.get?.('authorization');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
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

module.exports = {
  integrationsRateLimitKey,
  writeIntegrationsRateLimit,
  listIntegrationsRateLimit,
};
