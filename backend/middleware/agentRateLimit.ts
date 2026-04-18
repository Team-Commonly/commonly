/**
 * Per-agent-token rate limit middleware (ADR-003 Phase 4).
 *
 * Three new agent-runtime routes (memory/shared, pods/:id/ask, asks/:id/respond)
 * needed an outer DoS bound. The `ask` path also throttles inside the service
 * (30/hour per agent+podId); this middleware is the wider per-token cap that
 * also covers the read-shared and respond routes.
 *
 * Implemented on top of `express-rate-limit` because (a) it's the de-facto
 * standard middleware that static analysis (CodeQL `js/missing-rate-limiting`)
 * recognizes, and (b) it handles edge cases (clock skew, header serialization,
 * IPv6 normalization) we'd otherwise re-derive.
 *
 * Key strategy: prefer the SHA-256 hash of the bearer token (set by
 * agentRuntimeAuth as `req.agentTokenHash`). Fall back to hashing the
 * Authorization header itself, then to the remote IP. Hashing keeps the raw
 * token out of in-memory state.
 *
 * Single-replica assumption: the in-memory MemoryStore matches the current
 * deployment (replicaCount: 1 in values-dev.yaml). When scaling backend >1,
 * swap the store for `rate-limit-redis` or similar — the keyGenerator stays
 * unchanged.
 */

import type { Request, Response, RequestHandler } from 'express';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';

const tokenKey = (req: Request): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = req as any;
  if (r.agentTokenHash) return `tok:${r.agentTokenHash}`;
  const auth = req.headers?.authorization || req.headers?.['x-commonly-agent-token'];
  if (typeof auth === 'string' && auth.length > 0) {
    return `hdr:${createHash('sha256').update(auth).digest('hex')}`;
  }
  return `ip:${req.ip || 'unknown'}`;
};

export const agentRateLimit = (
  opts: { windowMs?: number; max?: number } = {},
): RequestHandler => rateLimit({
  windowMs: Math.max(1000, opts.windowMs ?? 60_000),
  max: Math.max(1, opts.max ?? 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenKey,
  handler: (req: Request, res: Response) => {
    const limit = res.getHeader('RateLimit-Limit');
    const reset = res.getHeader('RateLimit-Reset');
    res.status(429).json({
      message: `rate limit exceeded${limit ? `: ${limit} requests per window` : ''}`,
      code: 'rate_limited',
      retryAfter: typeof reset === 'string' || typeof reset === 'number' ? reset : undefined,
    });
  },
});

export default agentRateLimit;

// CJS compat: let `require()` return the factory directly while still exposing
// the named export through the same module.exports surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports['default'];
Object.assign(module.exports, exports);
