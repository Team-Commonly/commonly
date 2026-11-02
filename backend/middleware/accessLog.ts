/**
 * Access log: one JSON line per answered request (F57, Cofounder 2026-11-02).
 *
 * WHY THIS EXISTS. On 11-02 the question "how often was this endpoint called,
 * and by whom" came up, and only its first half could be answered: the backend
 * logged no requests, and the ingress-nginx access line carries the raw path
 * but no caller. This line carries the caller and leaves the path out.
 *
 * THE LINE, AND NOTHING ELSE:
 *   - `method`, `status`, `ms` (wall time from arrival to `finish`).
 *   - `route` — the template Express matched, mount prefix included
 *     (`/api/users/:id/public-activity`), never `req.originalUrl`: no ids, no
 *     query strings. A request no route matched is `<unmatched>`, because its
 *     path is whatever the caller typed.
 *   - `caller` — HMAC-SHA256 of the caller's user id, keyed, first 16 hex. A
 *     plain hash of an ObjectId is reversible by anyone holding the user list,
 *     so it is keyed; it is derived from JWT_SECRET under a fixed label, which
 *     never exposes the secret and changes when the secret rotates. `null` when
 *     signed out. Humans (`req.userId`) and agents (`req.agentUser`) alike.
 *   - `self` — the caller's own id is one of the route's params, so "someone
 *     else looked this up" is answerable without logging either id.
 *
 * WHAT IT NEVER CARRIES: headers, bodies, query strings, raw ids or IPs.
 *
 * THE TEMPLATE IS CAPTURED WHEN EXPRESS ASSIGNS `req.route`, not read at
 * `finish`. Express sets `req.route` while `req.baseUrl` is still the matched
 * router's mount (express/lib/router/index.js), and restores `baseUrl` and
 * `params` when an error unwinds a router, so a template read at `finish`
 * would lose its prefix on every thrown error. `self` reads `params` at
 * `finish` and so is `false` for a request that errored out of its router.
 *
 * Health probes are skipped: they are most of the traffic and none of the
 * question. Off under jest unless a test turns it on, and `ACCESS_LOG=off`
 * turns it off in a running process. Volume and cost: SRE measured ~10M
 * non-probe requests a month; the nginx controller's non-5xx access lines are
 * excluded in Cloud Logging in exchange, which keeps the project inside its
 * free ingestion.
 */
import { createHmac } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const SKIP_PREFIXES = ['/api/health'];
const CALLER_HASH_LENGTH = 16;

export const callerHash = (callerId: string | null, secret: string | undefined): string | null => {
  if (!callerId || !secret) return null;
  return createHmac('sha256', secret).update(`access-log\u0000${callerId}`).digest('hex').slice(0, CALLER_HASH_LENGTH);
};

// `baseUrl` is the URL text the mount matched, not its pattern, so it is only
// safe because no router is mounted on a parameter path (server.test.js guards
// that); it is lowercased because Express matches mounts case-insensitively.
const templateOf = (baseUrl: string, route: { path?: unknown }): string => (
  `${(baseUrl || '').toLowerCase()}${typeof route.path === 'string' ? route.path : '<pattern>'}`
);

const callerIdOf = (req: any): string | null => {
  const id = req.userId || req.agentUser?._id || req.user?.id;
  return id ? String(id) : null;
};

interface AccessLogOptions {
  log?: (line: string) => void;
  secret?: string;
  enabled?: boolean;
}

export const createAccessLog = ({
  log = (line: string) => { process.stdout.write(`${line}\n`); },
  secret = process.env.JWT_SECRET,
  enabled = process.env.ACCESS_LOG !== 'off' && process.env.NODE_ENV !== 'test',
}: AccessLogOptions = {}) => (req: Request, res: Response, next: NextFunction) => {
  if (!enabled) return next();
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return next();

  const startedAt = process.hrtime.bigint();
  let template: string | null = null;
  let route: unknown;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => route,
    set: (value) => {
      route = value;
      if (value) template = templateOf(req.baseUrl, value);
    },
  });

  res.on('finish', () => {
    try {
      const callerId = callerIdOf(req);
      const self = Boolean(callerId)
        && Object.values(req.params || {}).some((value) => String(value) === callerId);
      log(JSON.stringify({
        log: 'access',
        method: req.method,
        route: template || '<unmatched>',
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
        caller: callerHash(callerId, secret),
        self,
      }));
    } catch {
      // A log line must never take a response down with it.
    }
  });
  return next();
};

export const accessLog = createAccessLog();

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { createAccessLog, accessLog, callerHash };
