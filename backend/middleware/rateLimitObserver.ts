/**
 * Watermark log for the agent-runtime rate-limit stack (TASK-109, TASK-097 §6).
 *
 * WHY THIS EXISTS. The mount-level decision on `/api/agents/runtime` (`(A)` in
 * TASK-097 §6) is gated on the fleet's real per-token request rate against the
 * existing 120/60s budget. Nothing persists that rate: `phase4AgentRateLimit`
 * uses `express-rate-limit`'s default in-memory store, so the only place the
 * real count exists is the live `RateLimit-Remaining` header, per backend
 * process — and `tool_calls` cannot stand in as a proxy (5 rows all-time, one
 * seat, 2026-09-18). Without an instrument the only honest word for the
 * number is "derived", so this middleware makes it measurable.
 *
 * SHAPE (scoped by Vera, 71401): a WATERMARK log, not an access log. A line is
 * emitted only when the counter has climbed to `used >= watermark`, so an idle
 * fleet emits nothing and the log's volume is proportional to the thing being
 * measured. Default watermark is 60, i.e. half of the token tier's 120.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. No method, path, query, status, headers
 * or body — no request material at all. That is not tidiness: a log line with
 * the Authorization header in it is a credential in a log, and the observation
 * target is a counter, not traffic. The `key` field is the limiter's own key,
 * which this stack already builds as `tok:<sha256>` / `hdr:<sha256>` /
 * `ip:<prefix>` (`agentRateLimitKeyGenerator`) — a hash or an IP prefix, never
 * a credential.
 *
 * MOUNT POSITION DETERMINES WHAT IT READS. `express-rate-limit` sets
 * `req.rateLimit = { limit, used, remaining, resetTime, key }` and each limiter
 * in a stack overwrites it, so mounting this one LAST in the stack reports the
 * tier it follows — for `phase4RateLimit` that is the per-token tier, not the
 * IP tier. (Field shape verified against the installed 8.3.2, not the docs.)
 *
 * AND IT NEVER SEES A REFUSAL. The limiter answers the request that crosses the
 * ceiling, so the chain stops there and this middleware is not reached: a log
 * records the approach to the ceiling and the saturation at it, never the
 * crossing. That makes the log a lower bound on real peaks — a 60s window in
 * which 200 requests were refused still logs at most `used == 120`. Read it as
 * "the budget was reached", not as "the budget was the whole traffic".
 *
 * FAILING OPEN IS THE POINT. Both the flag read and the sink call are wrapped so
 * that a broken instrument logs nothing and a route still serves: an observation
 * must never turn a 200 into a 500, or the instrument becomes the incident.
 *
 * OFF BY DEFAULT. `RATE_LIMIT_OBSERVE` must be truthy (`1`/`true`/`yes`/`on`);
 * `RATE_LIMIT_OBSERVE_WATERMARK` overrides the 60 default. Because the flag is
 * read per request, flipping it needs no code change — but it is still an env
 * var on a deployment, so turning it on is a rollout, not a call.
 */

import type { NextFunction, Request, Response } from 'express';

/** Entry emitted once a key's counter reaches the watermark. */
export type RateLimitObservation = {
  event: 'agent_rate_limit_watermark';
  /** The limiter's own key: `tok:<sha256>` | `hdr:<sha256>` | `ip:<prefix>`. */
  key: string;
  /** Counter value after this request — same field names the limiter sets. */
  used: number;
  limit: number;
  remaining: number;
  resetTime: string | null;
  /** Which backend replica served it; the in-memory store is per replica. */
  replica: string;
  at: string;
};

type Env = Record<string, string | undefined>;
type Sink = (entry: RateLimitObservation) => void;

export const DEFAULT_OBSERVE_WATERMARK = 60;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Flag is off unless it says otherwise; unset, empty and `0` all mean off. */
export const isObserveEnabled = (env: Env = process.env): boolean => {
  const raw = env.RATE_LIMIT_OBSERVE;
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
};

/**
 * Watermark must be a positive integer; anything else falls back to the default
 * rather than silently disabling the log (a typo should not look like "the
 * fleet is idle").
 */
export const observeWatermark = (env: Env = process.env): number => {
  const raw = Number.parseInt(String(env.RATE_LIMIT_OBSERVE_WATERMARK ?? ''), 10);
  return raw > 0 ? raw : DEFAULT_OBSERVE_WATERMARK;
};

const defaultSink: Sink = (entry) => {
  // Repo convention for backend diagnostics: a tag then the object.
  // eslint-disable-next-line no-console
  console.log('[rate-limit-observe]', entry);
};

export type RateLimitObserverOptions = {
  env?: Env;
  sink?: Sink;
  /** Injected in tests; defaults to the pod name Kubernetes sets in HOSTNAME. */
  replica?: string;
  now?: () => Date;
};

/**
 * Build the observer. Injectable so the tests can drive it with a fake env and
 * a fake sink instead of mutating `process.env` and spying on `console`.
 */
export const createRateLimitObserver = (options: RateLimitObserverOptions = {}) => {
  const env = options.env ?? process.env;
  const sink = options.sink ?? defaultSink;
  const replica = options.replica ?? process.env.HOSTNAME ?? 'unknown';
  const now = options.now ?? (() => new Date());

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (isObserveEnabled(env)) {
        // `req.rateLimit` is absent whenever no limiter ran before this one —
        // an unlimited route, or a test that mounts the observer alone. That is
        // not an error, it is "nothing to report".
        const info = (req as Request & { rateLimit?: Partial<RateLimitObservation> }).rateLimit;
        const used = typeof info?.used === 'number' ? info.used : null;
        if (used !== null && used >= observeWatermark(env)) {
          sink({
            event: 'agent_rate_limit_watermark',
            key: typeof info?.key === 'string' ? info.key : 'unknown',
            used,
            limit: typeof info?.limit === 'number' ? info.limit : 0,
            remaining: typeof info?.remaining === 'number' ? info.remaining : 0,
            resetTime: info?.resetTime ? String(info.resetTime) : null,
            replica,
            at: now().toISOString(),
          });
        }
      }
    } catch {
      // An instrument that can refuse a request is a worse instrument than none.
    }
    next();
  };
};

/** The production instance: process env, console sink, HOSTNAME replica. */
export const rateLimitObserver = createRateLimitObserver();

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  createRateLimitObserver,
  rateLimitObserver,
  isObserveEnabled,
  observeWatermark,
  DEFAULT_OBSERVE_WATERMARK,
};
