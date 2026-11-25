/**
 * Name the client behind a rate-limit rejection, once per limiter key per minute.
 *
 * F631: prod took ~500 rejected requests a minute on each of two daemon routes
 * and the access log could not say whose credential was looping (no caller, no
 * limiter key, no path id, no user agent). A limiter's handler calls the logger
 * this module builds, and it prints one line per key per window, carrying how
 * many rejections it swallowed since that key's last line.
 *
 * What the line may hold, and nothing else:
 *   - the limiter name and the route pattern (`req.baseUrl + req.route.path`,
 *     or the method plus `req.path` with ids replaced; never the query string);
 *   - the key's kind, and for a `tok:` key the first 8 hex of its existing
 *     sha256 prefix. An `ip` key logs only its kind: the IP never leaves;
 *   - `machineDbId`, the `:id` path param, only when it is a 24-hex ObjectId;
 *   - the user agent cut to a leading `name/version` token (40 chars max),
 *     else `other`;
 *   - `suppressed`, the rejections for this key since its last logged line.
 * No header value, body or raw URL is read. The format is a fixed string and
 * every value goes in as data (see utils/safeErrorLog.ts and the "log the raw
 * tainted value" entry in docs/security-patterns.md).
 *
 * Memory is bounded: the per-key map holds at most `maxKeys` entries. On
 * insert it prunes entries whose window has passed (the map is kept in
 * last-logged order, so they sit at the front), then drops the oldest if it is
 * still full. An evicted key loses its suppressed count; under a flood of
 * distinct keys each one is logged anyway, so nothing is hidden.
 */

const LOG_FORMAT = '[rate-limit] rejected %j';
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UA_TOKEN = /^[A-Za-z][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// Cut the user agent at its first whitespace or control character, so a
// header carrying `\r\n…` keeps only what came before it.
// eslint-disable-next-line no-control-regex
const UA_CUT = /[\s\x00-\x1f\x7f]/;
const TOK_KEY = /^tok:([0-9a-f]{8})/;
const ID_SEGMENT = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;
const UA_MAX = 40;
const UA_INPUT_MAX = 256;
const ROUTE_MAX = 120;

export interface RateLimitedRequest {
  method?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  rateLimit?: { key?: unknown };
  get?: (header: string) => string | undefined;
}

export interface RateLimitRejectionLogOptions {
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  log?: (format: string, fields: Record<string, unknown>) => void;
}

export interface RateLimitRejectionLog {
  (req: RateLimitedRequest): void;
  size: () => number;
}

export const userAgentFamily = (raw: unknown): string => {
  if (typeof raw !== 'string') return 'other';
  const token = raw.slice(0, UA_INPUT_MAX).split(UA_CUT)[0];
  if (!token || !UA_TOKEN.test(token)) return 'other';
  return token.slice(0, UA_MAX);
};

export const routeLabel = (req: RateLimitedRequest): string => {
  const method = typeof req.method === 'string' ? req.method.toUpperCase().slice(0, 10) : 'UNKNOWN';
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
    return `${method} ${base}${routePath}`.slice(0, ROUTE_MAX);
  }
  const path = typeof req.path === 'string' ? req.path : '';
  const stripped = path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return `${method} ${stripped}`.slice(0, ROUTE_MAX);
};

const describeKey = (key: unknown): { keyKind: 'tok' | 'ip'; keyPrefix?: string } => {
  const match = typeof key === 'string' ? TOK_KEY.exec(key) : null;
  return match ? { keyKind: 'tok', keyPrefix: match[1] } : { keyKind: 'ip' };
};

export const createRateLimitRejectionLog = (
  limiter: string,
  {
    windowMs = 60_000,
    maxKeys = 1000,
    now = Date.now,
    log = (format, fields) => console.warn(format, fields),
  }: RateLimitRejectionLogOptions = {},
): RateLimitRejectionLog => {
  const seen = new Map<string, { loggedAt: number; suppressed: number }>();

  const makeRoom = (at: number) => {
    for (const [key, entry] of seen) {
      if (at - entry.loggedAt < windowMs) break;
      seen.delete(key);
    }
    while (seen.size >= maxKeys) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  };

  const record = ((req: RateLimitedRequest) => {
    try {
      const rawKey = req.rateLimit?.key;
      const key = typeof rawKey === 'string' ? rawKey : '';
      const at = now();
      const entry = seen.get(key);
      if (entry && at - entry.loggedAt < windowMs) {
        entry.suppressed += 1;
        return;
      }
      const suppressed = entry ? entry.suppressed : 0;
      // Re-insert so the map stays in last-logged order for pruning.
      seen.delete(key);
      makeRoom(at);
      seen.set(key, { loggedAt: at, suppressed: 0 });

      const fields: Record<string, unknown> = {
        limiter,
        route: routeLabel(req),
        ...describeKey(key),
      };
      const id = req.params?.id;
      if (typeof id === 'string' && OBJECT_ID.test(id)) fields.machineDbId = id;
      fields.ua = userAgentFamily(req.get?.('user-agent'));
      fields.suppressed = suppressed;
      log(LOG_FORMAT, fields);
    } catch {
      // A log line must never turn a 429 into a 500.
    }
  }) as RateLimitRejectionLog;
  record.size = () => seen.size;
  return record;
};
