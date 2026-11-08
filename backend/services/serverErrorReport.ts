/**
 * What reaches Sentry from this backend (F325). Two jobs, one file, because the
 * second is what makes the first safe:
 *
 *   - `serverErrorReport`, a `finish` middleware: any 5xx response becomes one
 *     Sentry event, so a route's own `res.status(500)` is seen. A request whose
 *     error Sentry's Express handler already captured (`res.sentry` holds that
 *     event's id) is skipped.
 *   - `scrubSentryEvent`, the only `beforeSend`: an allowlist. OAuth vendor and
 *     secret-storage errors can embed token values (#2555), so no message,
 *     exception text, URL, tag or context leaves, whatever produced it.
 *
 * THE SAFE PATH IS CLOSED TO OTHER EVENTS BY CONSTRUCTION. A report's title,
 * tags and fingerprint are never read from an event. The middleware captures an
 * EMPTY event and passes a frozen record in the SDK hint; `scrubSentryEvent`
 * writes the title from that record, and only if the record is in `issued`, a
 * WeakSet private to this module. Text inside an error cannot reach a hint, a
 * look-alike object is not in the set, and the record's route is built here, one
 * allowed segment at a time.
 *
 * Loaded by instrument.ts, before everything else: keep this module free of app
 * imports, and of any runtime import of express.
 */
import type { NextFunction, Request, Response } from 'express';

const nodePath = require('path') as typeof import('path');
const Sentry = require('@sentry/node') as typeof import('@sentry/node');

const FIXED_TEXT = 'Unhandled request error';
const WINDOW_MS = 15 * 60 * 1000;
// One process. Sentry's free tier is 5,000 errors a month; 60 a day is 1,860 in a 31-day month.
const DAILY_CAP = 60;
// One fingerprint, one day. The window alone allows 96, so a route failing all
// day would spend DAILY_CAP by mid-afternoon and silence every other route.
const ROUTE_DAILY_CAP = 8;
// Sentry drops a tag value over 200 characters.
const MAX_ROUTE_LENGTH = 180;
const MAX_NAME_LENGTH = 64;
const HEALTH_PREFIX = '/api/health';
const UNMATCHED = 'unmatched';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);
// An error event with these and nothing else still groups, dates and attributes.
const KEPT_FIELDS = ['event_id', 'timestamp', 'platform', 'release', 'environment', 'dist', 'sdk', 'server_name'];

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ROUTE_PARAM = /^:[A-Za-z_][A-Za-z0-9_]{0,31}\??$/;
const PATH_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const ID_SHAPED = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FILE_PATH = /^(?:app:\/\/)?\/[A-Za-z0-9_@+./-]+$/;
const NODE_INTERNAL = /^node:[a-z_/]+$/;
const APP_ROOT = nodePath.resolve(__dirname, '..');

const digitCount = (text: string): number => text.replace(/\D/g, '').length;

// A random token has digits all through it; a name someone wrote does not.
const looksGenerated = (text: string): boolean => (
  text.length > MAX_NAME_LENGTH || (text.length >= 16 && digitCount(text) >= 5)
);

interface Report {
  method: string;
  route: string;
  status: number;
}

const issued = new WeakSet<object>();
// F326: what the routing saw for each request, and the route of each error that
// reached the error middleware. Keyed on objects this process made, so nothing
// an error carries can add an entry.
const routingByRequest = new WeakMap<object, Routing>();
const thrownAt = new WeakMap<object, Readonly<{ method: string; route: string }>>();

interface Routing {
  params: Set<string>;
  // The mount path when the route matched. Once an error unwinds a router,
  // `req.baseUrl` is reset, so the error middleware can't read it then.
  baseUrl: string;
}
const lastSentAt = new Map<string, { at: number; count: number }>();
let day = '';
let sentToday = 0;

const urlSegment = (segment: string): string => {
  if (ID_SHAPED.test(segment)) return ':id';
  return PATH_WORD.test(segment) && digitCount(segment) <= 3 ? segment : ':value';
};

const patternSegment = (segment: string): string => (
  ROUTE_PARAM.test(segment) ? segment.replace(/\?$/, '') : urlSegment(segment)
);

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// `baseUrl` is URL text, so a value under a param mount is in it; only a route's
// own pattern is code, which is why only a pattern may keep a `:name`. A word-
// shaped value (`sk_live_x`) passes `urlSegment`, so a segment equal to any
// param value the routing saw is `:value` too.
//
// Read at `finish`, where an error that unwound a router has reset `baseUrl`.
// That is fine here: such an error reached Sentry's handler and is not reported.
const routeOf = (
  req: { baseUrl?: string; route?: { path?: unknown } },
  paramValues: ReadonlySet<string> = new Set(),
): string => {
  if (!req.route) return UNMATCHED;
  const { path } = req.route;
  const baseSegment = (segment: string): string => {
    // One placeholder for every value the routing assigned, whatever its shape:
    // a hex id and a word under the same mount are one endpoint, one fingerprint.
    if (paramValues.has(segment) || paramValues.has(decoded(segment))) return ':value';
    return urlSegment(segment);
  };
  const segments = [
    ...String(req.baseUrl || '').split('/').filter(Boolean).map(baseSegment),
    ...(typeof path === 'string' ? path.split('/').filter(Boolean).map(patternSegment) : [':value']),
  ];
  return `/${segments.join('/')}`.slice(0, MAX_ROUTE_LENGTH);
};

// Every new fingerprint spends one of DAILY_CAP, so the map cannot outgrow it.
// DAILY_CAP is the backstop; ROUTE_DAILY_CAP keeps one route from spending it.
const admit = (key: string, now: number): boolean => {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
    // A window open at midnight stays open; only the day's counts restart.
    lastSentAt.forEach((entry, fingerprint) => {
      if (now - entry.at >= WINDOW_MS) lastSentAt.delete(fingerprint);
      else lastSentAt.set(fingerprint, { at: entry.at, count: 0 });
    });
  }
  const last = lastSentAt.get(key);
  if (last && (now - last.at < WINDOW_MS || last.count >= ROUTE_DAILY_CAP)) return false;
  if (sentToday >= DAILY_CAP) return false;
  sentToday += 1;
  lastSentAt.set(key, { at: now, count: (last?.count ?? 0) + 1 });
  return true;
};

const isHealthPath = (req: Request): boolean => {
  // Express matches routes without case, so `/API/Health` is the health route.
  const path = String(req.originalUrl || '').split('?')[0].toLowerCase();
  return path === HEALTH_PREFIX || path.startsWith(`${HEALTH_PREFIX}/`);
};

const fingerprintOf = ({ method, route, status }: Report): string[] => ['5xx', method, route, String(status)];

// Express assigns `req.params` afresh at each layer, and a router without
// `mergeParams` drops its parent's, so by `finish` a mount's value can be gone
// from `req.params` while still in `baseUrl`. Keep every value assigned.
const watchParams = (req: Request): Set<string> => {
  const seen = new Set<string>();
  const routing: Routing = { params: seen, baseUrl: String(req.baseUrl || '') };
  routingByRequest.set(req, routing);
  const note = (params: unknown): void => {
    if (!params || typeof params !== 'object') return;
    Object.values(params).forEach((value) => {
      if (typeof value !== 'string') return;
      seen.add(value);
      value.split('/').forEach((part) => { if (part) seen.add(part); });
    });
  };
  let current = req.params;
  note(current);
  try {
    Object.defineProperty(req, 'params', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = value;
        note(value);
      },
    });
  } catch {
    // Without the watch, a word-shaped mount value is judged by its shape alone.
  }
  // A pattern in `req.route` is trusted as code: nothing in this backend
  // assigns it but Express (a stale one names the last matched route; F325
  // reads it the same way).
  // Express sets `req.route` as a route matches, with `baseUrl` still the full
  // mount, and never restores it as an error unwinds (it does restore
  // `baseUrl`, then `params`), so this is the moment to keep the mount.
  // Another middleware may watch `req.route` too (accessLog does, mounted
  // first): chain to its accessor, never replace it, or it stops seeing routes.
  try {
    const found = Object.getOwnPropertyDescriptor(req, 'route');
    const prior = found?.get && found?.set ? found : null;
    let route = prior ? undefined : found?.value;
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get: () => (prior ? prior.get!.call(req) : route),
      set: (value) => {
        if (prior) prior.set!.call(req, value);
        else route = value;
        routing.baseUrl = String(req.baseUrl || '');
      },
    });
  } catch {
    // Without it, a thrown error's route is named from its pattern alone.
  }
  return seen;
};

const reportResponse = (req: Request, res: Response, paramValues: ReadonlySet<string>): void => {
  const status = res.statusCode;
  if (status < 500 || status > 599 || (res as Response & { sentry?: unknown }).sentry) return;
  if (isHealthPath(req) || !Sentry.getClient()) return;

  const report: Report = Object.freeze({
    method: METHODS.has(req.method) ? req.method : 'OTHER',
    route: routeOf(req, paramValues),
    status,
  });
  if (!admit(fingerprintOf(report).join(' '), Date.now())) return;
  issued.add(report);
  Sentry.captureEvent({ level: 'error' }, { data: report });
};

export const serverErrorReport = (req: Request, res: Response, next: NextFunction): void => {
  const paramValues = watchParams(req);
  res.once('finish', () => {
    try {
      reportResponse(req, res, paramValues);
    } catch {
      // Reporting must never take a response down with it.
    }
  });
  next();
};

/**
 * F326: an error middleware, mounted just before Sentry's handler. A thrown
 * error reaches Sentry with its frames but, since the URL can carry a token,
 * with no URL at all. This records the request's route the way a 5xx report
 * builds it, one allowed segment at a time, keyed on the error object, so
 * `beforeSend` can name the endpoint. Nothing is read from the error.
 */
export const noteErrorRoute = (err: unknown, req: Request, _res: Response, next: NextFunction): void => {
  try {
    if (err && typeof err === 'object' && !thrownAt.has(err)) {
      const routing = routingByRequest.get(req);
      thrownAt.set(err, Object.freeze({
        method: METHODS.has(req.method) ? req.method : 'OTHER',
        route: routeOf({ baseUrl: routing?.baseUrl ?? '', route: req.route }, routing?.params),
      }));
    }
  } catch {
    // Naming the route is a nicety; the error goes on to Sentry either way.
  }
  next(err);
};

const thrownRoute = (hint: unknown): Readonly<{ method: string; route: string }> | null => {
  const original = (hint as { originalException?: unknown } | undefined)?.originalException;
  return original && typeof original === 'object' ? thrownAt.get(original) ?? null : null;
};

const plainFunction = (name: unknown): string | undefined => {
  if (typeof name !== 'string') return undefined;
  const plain = name.replace(/ \[as [\w$]+\]$/, '');
  const dotted = plain.replace(/^(?:async |new )/, '');
  const parts = dotted.split('.');
  const ok = parts.every((part) => (
    part === '<anonymous>' || part === '<computed>' || (IDENTIFIER.test(part) && !looksGenerated(part))
  ));
  return ok ? plain : undefined;
};

const plainFilename = (filename: unknown): string | undefined => {
  if (typeof filename !== 'string') return undefined;
  if (NODE_INTERNAL.test(filename)) return filename;
  if (!FILE_PATH.test(filename) || filename.split('/').some(looksGenerated)) return undefined;
  return filename;
};

// A frame says where the code is, never what it held. `module` and every source
// line go with the values: only these five fields, each checked.
const plainFrame = (frame: Record<string, unknown>): Record<string, unknown> | null => {
  const plain: Record<string, unknown> = {};
  const filename = plainFilename(frame.filename);
  const fn = plainFunction(frame.function);
  if (filename) plain.filename = filename;
  if (fn) plain.function = fn;
  if (!filename && !fn) return null;
  if (Number.isInteger(frame.lineno)) plain.lineno = frame.lineno;
  if (Number.isInteger(frame.colno)) plain.colno = frame.colno;
  if (typeof frame.in_app === 'boolean') plain.in_app = frame.in_app;
  const absPath = plainFilename(frame.abs_path);
  if (absPath?.startsWith(`${APP_ROOT}/`)) plain.abs_path = absPath;
  return plain;
};

const plainException = (exception: any): Record<string, unknown> => {
  const { type } = exception || {};
  const frames: unknown[] = Array.isArray(exception?.stacktrace?.frames) ? exception.stacktrace.frames : [];
  const kept = frames.map((frame) => plainFrame((frame || {}) as Record<string, unknown>)).filter(Boolean);
  return {
    type: typeof type === 'string' && IDENTIFIER.test(type) && !looksGenerated(type) ? type : 'Error',
    value: FIXED_TEXT,
    ...(kept.length > 0 && { stacktrace: { frames: kept } }),
  };
};

const issuedReport = (hint: unknown): Report | null => {
  const data = (hint as { data?: unknown } | undefined)?.data;
  return data && typeof data === 'object' && issued.has(data) ? (data as Report) : null;
};

/** `beforeSend`. Reads no text from `event`, whichever branch it takes. */
export const scrubSentryEvent = (event: any, hint?: unknown): any => {
  const scrubbed: Record<string, unknown> = {};
  KEPT_FIELDS.forEach((field) => {
    if (event[field] !== undefined) scrubbed[field] = event[field];
  });
  if (LEVELS.has(event.level)) scrubbed.level = event.level;

  const report = issuedReport(hint);
  if (report) {
    const { method, route, status } = report;
    return {
      ...scrubbed,
      message: `5xx ${status} ${method} ${route}`,
      tags: {
        source: 'handled_5xx', method, route, status: String(status),
      },
      fingerprint: fingerprintOf(report),
    };
  }

  if (event.message) scrubbed.message = FIXED_TEXT;
  if (event.exception) {
    const values = Array.isArray(event.exception.values) ? event.exception.values : [];
    scrubbed.exception = { values: (values.length > 0 ? values : [{}]).map(plainException) };
  }
  if (METHODS.has(event.request?.method)) scrubbed.request = { method: event.request.method };
  const thrown = thrownRoute(hint);
  if (thrown) {
    scrubbed.transaction = `${thrown.method} ${thrown.route}`;
    scrubbed.tags = { source: 'unhandled', method: thrown.method, route: thrown.route };
  }
  return scrubbed;
};

// `beforeSend` sees error events only. A check-in, session, span or attachment
// goes out without passing it (a check-in carries its monitor slug verbatim),
// so the client's `beforeEnvelope` hook keeps only the item types that did.
const SENT_ITEM_TYPES = new Set(['event', 'client_report']);

export const keepScrubbedItems = (envelope: unknown): void => {
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return;
  const items = envelope[1] as unknown[];
  const kept = items.filter((item) => (
    Array.isArray(item) && SENT_ITEM_TYPES.has((item[0] as { type?: string } | undefined)?.type ?? '')
  ));
  items.splice(0, items.length, ...kept);
};

export const resetReportStateForTest = (): void => {
  day = '';
  sentToday = 0;
  lastSentAt.clear();
};

export const reportStateForTest = (): { fingerprints: number; sentToday: number } => ({
  fingerprints: lastSentAt.size,
  sentToday,
});

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  DAILY_CAP,
  keepScrubbedItems,
  MAX_ROUTE_LENGTH,
  noteErrorRoute,
  reportStateForTest,
  ROUTE_DAILY_CAP,
  resetReportStateForTest,
  routeOf,
  scrubSentryEvent,
  serverErrorReport,
};
