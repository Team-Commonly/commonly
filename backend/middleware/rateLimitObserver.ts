/**
 * Watermark log for the agent-runtime rate-limit stack (TASK-109, TASK-097 §6).
 *
 * WHY THIS EXISTS. The mount-level decision on `/api/agents/runtime` (`(A)` in
 * TASK-097 §6) is gated on the fleet's real per-token request rate against the
 * existing 120/60s budget. Nothing persists that rate: `phase4AgentRateLimit`
 * uses `express-rate-limit`'s default in-memory store, so the only place the
 * real count exists is the live `RateLimit-Remaining` header, per backend
 * process — and `tool_calls` cannot stand in as a proxy (5 rows all-time, one
 * seat, 2026-09-18). Without an instrument the only honest word for the number
 * is "derived", so this middleware makes it measurable.
 *
 * SHAPE (spec: Vera 71402/71405/71406; field set and the two assertions below
 * are hers, not mine). A watermark log, not an access log: a line is emitted
 * only when the counter has climbed to `used >= watermark`, so an idle fleet
 * emits nothing and the log's volume is proportional to the thing measured.
 * Default watermark 60, i.e. half of the token tier's 120.
 *
 * THE LINE, AND NOTHING ELSE:
 *   - `key`   — the limiter's own key, shortened to its prefix plus the first 12
 *     characters: `tok:<12>` | `hdr:<12>`. An `ip:` key is kept whole: it is a
 *     bucket prefix, not a secret, and shortening it hides nothing. The prefix is kept
 *     because it says which KIND of bucket this is — a token, a header hash, or
 *     an IP — which is the difference between a per-seat reading and a
 *     per-connection one. Twelve hex characters is a correlation handle
 *     (48 bits), never the credential and never the full hash.
 *   - `route` — `req.route.path`, the pattern (`/messages/:messageId/claim`),
 *     never `req.originalUrl`: no ids, no query strings. Without it the log can
 *     say a ceiling was approached but not which call shape did it, which is
 *     exactly what decides whether a batch-claim loop is the cause.
 *   - `used`  — the counter. The only field that moves.
 *   - `resetInSeconds` — how long the window has left, so a reading can be
 *     placed in its window without a second clock.
 *   - `replica` — which backend process answered. The store is in-memory and
 *     per-process, so every count is per replica: one replica today, which makes
 *     it the whole picture, but a token spread across pods undercounts. Good for
 *     "does a batch turn approach 120"; not a fleet-wide total.
 *   - `event` — the line's own tag, so these are greppable among other output.
 *
 * `limit` and `remaining` are deliberately absent (Vera 71405): `limit` is the
 * constant 120 here, and `remaining` is arithmetic on the two fields above.
 * A field that repeats a constant is a field that can disagree with it.
 *
 * WHAT IT NEVER CARRIES: no method, path, status, headers, body, query or
 * original URL — no request material at all. That is not tidiness: a log line
 * with the Authorization header in it is a credential in a log, and the thing
 * being observed is a counter.
 *
 * ONE TIER, RECORDED RATHER THAN IMPLIED (wren 71410). This observer measures
 * the TOKEN tier alone, and only because it is mounted last: each limiter in a
 * stack overwrites `req.rateLimit`, last wins, so the reading is the tier whose
 * 120/60s budget `(A)` is about. The IP tier (3000/60s) is not observed here —
 * a second observer between `phase4IpRateLimit` and `phase4AgentRateLimit` would
 * be needed for that, and it is a separate row if anyone wants the
 * fleet-aggregate rate.
 *
 * AND IT NEVER SEES A REFUSAL. The limiter answers the request that crosses the
 * ceiling, so the chain stops there and this middleware is not reached: a log
 * records the approach to the ceiling and the saturation at it, never the
 * crossing. That makes it a LOWER bound on real peaks — a 60s window in which
 * 200 requests were refused still logs at most `used == limit`. Read it as "the
 * budget was reached", not as "the budget was the whole traffic".
 *
 * FAILING OPEN IS THE POINT. Both the flag read and the sink call are guarded so
 * that a broken instrument logs nothing and a route still serves: an observation
 * must never turn a 200 into a 500, or the instrument becomes the incident.
 *
 * OFF BY DEFAULT. `RATE_LIMIT_OBSERVE=1` (also accepts `true`/`yes`/`on`);
 * `RATE_LIMIT_OBSERVE_WATERMARK` overrides the 60 default. The flag is read per
 * request, so it needs no code change to flip — but it is still an env var on a
 * deployment, so turning it on is a rollout, not a call.
 *
 * REMOVAL (TASK-109 names its own): this comes out with its env flag once the
 * decision it exists to serve is taken — either the mount-level budget is set
 * from a reading, or `(A)` is decided the other way — and TASK-109's row closes
 * in the same PR that removes it.
 */

import type { NextFunction, Request, Response } from 'express';

/** Entry emitted once a key's counter reaches the watermark. */
export type RateLimitObservation = {
  event: 'agent_rate_limit_watermark';
  /** `<prefix>:<first 12 chars>` — a correlation handle, never the credential. */
  key: string;
  /** Route PATTERN (`/pods/:podId/messages`), or null when no route matched. */
  route: string | null;
  /** Counter value after this request — same field name the limiter sets. */
  used: number;
  /** Seconds until the window resets; null when the limiter reported no time. */
  resetInSeconds: number | null;
  /** Which backend replica answered — the store is per-process. */
  replica: string;
};

/**
 * What `express-rate-limit` puts on `req.rateLimit` — deliberately a different
 * type from what we emit, because the two are different things: the limiter's
 * counter and our line about it. Reading a field the limiter does not set is
 * then a type error rather than a permanently-null column.
 */
type LimiterCounter = {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
  key?: unknown;
};

type Env = Record<string, string | undefined>;
type Sink = (entry: RateLimitObservation) => void;

export const DEFAULT_OBSERVE_WATERMARK = 60;

/** How much of the limiter key survives: enough to correlate, not to identify. */
export const KEY_CORRELATION_LENGTH = 12;

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

/**
 * Shorten a limiter key to `<prefix>:<12 chars>`. An absent key is reported as
 * `unknown` rather than left blank, so every line says which bucket it came from.
 *
 * The `tok:` and `hdr:` remainders are hashes, and a hash is the credential's
 * index: `agentRateLimitKeyGenerator` keys on `${req.agentTokenHash}`, which is
 * the exact `AgentCredential.findOne({ tokenHash })` lookup key, and the header
 * fallback is a full sha256 of the Authorization header. Logging either whole
 * makes every line joinable 1:1 to a live credential row for no gain (Vera
 * 71425), so only the first 12 hex survive — enough to correlate ~30 seats, not
 * enough to join.
 *
 * `ip:` is the exception and is kept whole: it is a bucket prefix, not a secret,
 * and shortening it would cost the bucket while hiding nothing (Vera 71426).
 */
export const correlationKey = (key: unknown): string => {
  if (typeof key !== 'string' || key.length === 0) return 'unknown';
  const separator = key.indexOf(':');
  if (separator <= 0) return key.slice(0, KEY_CORRELATION_LENGTH);
  const prefix = key.slice(0, separator + 1);
  if (prefix === 'ip:') return key;
  return `${prefix}${key.slice(separator + 1, separator + 1 + KEY_CORRELATION_LENGTH)}`;
};

/** Seconds left in the window, floored at 0 so clock skew cannot go negative. */
export const secondsUntilReset = (resetTime: unknown, now: Date): number | null => {
  if (!(resetTime instanceof Date) || Number.isNaN(resetTime.getTime())) return null;
  return Math.max(0, Math.ceil((resetTime.getTime() - now.getTime()) / 1000));
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
        // `req.rateLimit` is absent whenever no limiter ran before this one — an
        // unlimited route, or a test that mounts the observer alone. That is not
        // an error, it is "nothing to report".
        const info = (req as Request & { rateLimit?: LimiterCounter }).rateLimit;
        const used = typeof info?.used === 'number' ? info.used : null;
        if (used !== null && used >= observeWatermark(env)) {
          const route = (req as Request & { route?: { path?: string } }).route;
          sink({
            event: 'agent_rate_limit_watermark',
            key: correlationKey(info?.key),
            route: typeof route?.path === 'string' ? route.path : null,
            used,
            resetInSeconds: secondsUntilReset(info?.resetTime, now()),
            replica,
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
  correlationKey,
  secondsUntilReset,
  DEFAULT_OBSERVE_WATERMARK,
  KEY_CORRELATION_LENGTH,
};
