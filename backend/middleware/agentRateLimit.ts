/**
 * Per-agent-token rate limit middleware.
 *
 * ADR-003 Phase 4 added three new agent-runtime routes (memory/shared,
 * pods/:id/ask, asks/:id/respond). The `ask` route already throttles at the
 * service layer (30/hour per fromAgent+podId), but the read-shared and
 * respond routes had no DoS bound — a compromised agent token could spam
 * either endpoint to drain DB read capacity or saturate the event queue.
 *
 * Pattern: in-memory fixed-window counter keyed by the SHA-256 hash of the
 * bearer token (req.agentTokenHash, set by agentRuntimeAuth). Hashing keeps
 * the raw token out of process memory and makes the key stable across
 * subdomain-routed requests.
 *
 * Tradeoffs intentionally accepted for Phase 4:
 *   - Memory-only — counters reset on backend restart. Acceptable: bypass
 *     requires the attacker to outlive a pod restart, which is itself a
 *     coarser DoS concern handled elsewhere (k8s liveness, OOM kill).
 *   - Per-pod scope is NOT factored in — the limit is per token globally
 *     across pods. This is intentionally conservative: a compromised token
 *     SHOULD be choked across all surfaces, not just the current pod.
 *   - No Redis / cluster-coordinated state. Backend currently runs single-
 *     replica per environment (replicaCount: 1 in values-dev.yaml). When
 *     scaling >1 replicas, swap the in-memory map for a shared store.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

interface CounterEntry {
  count: number;
  windowStart: number;
}

const counters = new Map<string, CounterEntry>();

const tokenKey = (req: Request): string => {
  // agentRuntimeAuth populates these; falling back to remote IP keeps the
  // limiter defensive even if the middleware order ever shifts (e.g.
  // someone wires the rate limit BEFORE auth and a malformed request slips
  // through).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = req as any;
  if (r.agentTokenHash) return `tok:${r.agentTokenHash}`;
  const auth = req.headers?.authorization || req.headers?.['x-commonly-agent-token'];
  if (typeof auth === 'string' && auth.length > 0) {
    return `hdr:${createHash('sha256').update(auth).digest('hex')}`;
  }
  return `ip:${req.ip || 'unknown'}`;
};

const sweep = (now: number, windowMs: number): void => {
  // Best-effort cleanup of stale entries so the map doesn't grow unbounded
  // for tokens that fire once and never return. Cheap because we only sweep
  // when the map crosses a soft cap.
  if (counters.size < 10_000) return;
  for (const [k, v] of counters) {
    if (now - v.windowStart > windowMs * 2) counters.delete(k);
  }
};

export const agentRateLimit = (
  opts: { windowMs?: number; max?: number } = {},
) => {
  const windowMs = Math.max(1000, opts.windowMs ?? 60_000);
  const max = Math.max(1, opts.max ?? 60);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = tokenKey(req);
    const now = Date.now();
    const entry = counters.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      counters.set(key, { count: 1, windowStart: now });
      sweep(now, windowMs);
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - entry.windowStart)) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        message: `rate limit exceeded: ${max} requests per ${Math.round(windowMs / 1000)}s`,
        code: 'rate_limited',
        retryAfter,
      });
      return;
    }
    next();
  };
};

// Test-only escape hatch — no production path uses this.
export const __resetAgentRateLimit = () => counters.clear();

export default agentRateLimit;

// CJS compat: let `require()` return the middleware factory directly while
// still exposing the named helpers via the same module.exports surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports['default'];
Object.assign(module.exports, exports);
