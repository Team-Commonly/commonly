import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

type RateLimitRequest = {
  get?: (header: string) => string | undefined;
  ip?: string;
};

// Connector writes can mint bearer connect codes. Keep the key and limits in
// one module so every route that creates or re-mints a connector shares the
// same bucket instead of each route being independently burstable.
export const integrationsRateLimitKey = (req: RateLimitRequest): string => {
  const authHeader = req.get?.('authorization');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
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
