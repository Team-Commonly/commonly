/**
 * Per-agent-token rate limit primitives (ADR-003 Phase 4).
 *
 * The actual `express-rate-limit` invocation lives inline in
 * `routes/agentsRuntime.ts` so CodeQL's js/missing-rate-limiting query
 * recognises the middleware against each route. This module exposes only
 * the shared key generator — every Phase 4 limiter must use the same key
 * shape so multiple routes share a per-token budget instead of stacking.
 *
 * Key strategy: prefer the SHA-256 hash of the bearer token (set by
 * agentRuntimeAuth as `req.agentTokenHash`). Fall back to hashing the
 * Authorization header itself, then to the remote IP. Hashing keeps the
 * raw token out of in-memory state.
 */

import type { Request } from 'express';
import { createHash } from 'crypto';

export const agentRateLimitKeyGenerator = (req: Request): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = req as any;
  if (r.agentTokenHash) return `tok:${r.agentTokenHash}`;
  const auth = req.headers?.authorization || req.headers?.['x-commonly-agent-token'];
  if (typeof auth === 'string' && auth.length > 0) {
    return `hdr:${createHash('sha256').update(auth).digest('hex')}`;
  }
  return `ip:${req.ip || 'unknown'}`;
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { agentRateLimitKeyGenerator };
