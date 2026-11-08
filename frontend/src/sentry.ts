import * as Sentry from '@sentry/react';

const sentryDsn = process.env.REACT_APP_SENTRY_DSN;

// An event says where an error happened, never what it said. This matches the
// backend (backend/instrument.ts): no text from the error leaves the browser.
// What an event keeps: the error type (if built in), stack frame locations, the
// boundary tag, release and environment, the React component stack, and URLs
// reduced to origin and path. docs/runbooks/error-tracking.md lists it.

const ERROR_VALUE = 'Error text is not sent';
const MASK = '[masked]';

const BUILT_IN_ERROR_TYPES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'URIError', 'EvalError', 'AggregateError',
]);

// Path segments that name a person, a file, or a one-time link. Each rule
// masks the segment that follows the listed ones.
const shouldMaskSegment = (segments: string[], i: number): boolean => {
  const prev = segments[i - 1];
  const prev2 = segments[i - 2];
  if (prev === 'invite' || prev === 'invites') return true; // /v2/invite/:x, /api/invites/:x
  if (prev === 'users' || prev === 'profile' || prev === 'uploads') return true;
  if (prev === 'unsubscribe' && prev2 === 'email' && segments[i] !== 'needs-you') return true;
  if (prev === 'needs-you' && prev2 === 'unsubscribe') return true;
  if (prev === 'open' && prev2 === 'needs-you') return true;
  return false;
};

const maskPath = (pathname: string): string => {
  const segments = pathname.split('/');
  return segments.map((segment, i) => (segment && shouldMaskSegment(segments, i) ? MASK : segment)).join('/');
};

// Origin plus path: no userinfo, query string or fragment.
export const reduceUrl = (raw: string): string => {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(raw);
  if (scheme && /^(data|blob|javascript)$/i.test(scheme[1])) return `${scheme[1]}:`;
  const isProtocolRelative = raw.startsWith('//');
  if (scheme || isProtocolRelative || raw.startsWith('/')) {
    try {
      const url = new URL(raw, 'https://commonly.invalid');
      const path = maskPath(url.pathname);
      if (isProtocolRelative) return `//${url.host}${path}`;
      if (!scheme) return path;
      return `${url.protocol}//${url.host}${path}`;
    } catch {
      // Falls through to the plain cut below.
    }
  }
  return raw.split(/[?#]/)[0];
};

const reduceIfString = (value: unknown): unknown => (typeof value === 'string' ? reduceUrl(value) : value);

const pick = <T extends object>(source: T | undefined, keys: readonly string[]): Partial<T> => {
  const out: Record<string, unknown> = {};
  if (!source) return out as Partial<T>;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
};

const BREADCRUMB_KEYS = ['type', 'category', 'level', 'timestamp', 'event_id'] as const;
const BREADCRUMB_DATA_KEYS = ['from', 'to', 'url', 'method', 'status_code', 'logger', 'ui.component_name'] as const;

const scrubBreadcrumb = (breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb => {
  const scrubbed: Sentry.Breadcrumb = pick(breadcrumb, BREADCRUMB_KEYS);
  if (breadcrumb.data) {
    const data: Record<string, unknown> = pick(breadcrumb.data, BREADCRUMB_DATA_KEYS);
    for (const key of ['from', 'to', 'url']) {
      if (key in data) data[key] = reduceIfString(data[key]);
    }
    scrubbed.data = data;
  }
  return scrubbed;
};

const FRAME_KEYS = ['filename', 'abs_path', 'function', 'module', 'lineno', 'colno', 'in_app'] as const;
const MECHANISM_KEYS = [
  'type', 'handled', 'synthetic', 'source', 'exception_id', 'parent_id', 'is_exception_group',
] as const;

const scrubFrame = (frame: Sentry.StackFrame): Sentry.StackFrame => {
  const kept: Sentry.StackFrame = pick(frame, FRAME_KEYS);
  if (typeof kept.filename === 'string') kept.filename = reduceUrl(kept.filename);
  if (typeof kept.abs_path === 'string') kept.abs_path = reduceUrl(kept.abs_path);
  return kept;
};

const scrubException = (value: Sentry.Exception): Sentry.Exception => {
  const kept: Sentry.Exception = {
    type: typeof value.type === 'string' && BUILT_IN_ERROR_TYPES.has(value.type) ? value.type : 'Error',
    value: ERROR_VALUE,
  };
  if (value.mechanism) kept.mechanism = pick(value.mechanism, MECHANISM_KEYS) as NonNullable<Sentry.Exception['mechanism']>;
  if (value.stacktrace?.frames) kept.stacktrace = { frames: value.stacktrace.frames.map(scrubFrame) };
  return kept;
};

const scrubContexts = (contexts: Sentry.Event['contexts']): Sentry.Event['contexts'] | undefined => {
  if (!contexts) return undefined;
  const kept: NonNullable<Sentry.Event['contexts']> = {};
  const componentStack = contexts.react?.componentStack;
  if (typeof componentStack === 'string') kept.react = { componentStack };
  if (contexts.trace) kept.trace = pick(contexts.trace, ['trace_id', 'span_id', 'parent_span_id']) as typeof contexts.trace;
  if (contexts.culture) kept.culture = pick(contexts.culture, ['locale', 'timezone']);
  return Object.keys(kept).length ? kept : undefined;
};

const scrubEvent = <E extends Sentry.Event>(event: E): E => {
  const scrubbed = { ...event };
  for (const key of ['user', 'message', 'logentry', 'extra', 'transaction', 'fingerprint'] as const) {
    delete scrubbed[key];
  }

  if (event.breadcrumbs) scrubbed.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

  if (event.exception) {
    scrubbed.exception = event.exception.values
      ? { values: event.exception.values.map(scrubException) }
      : {};
  }

  delete scrubbed.contexts;
  const contexts = scrubContexts(event.contexts);
  if (contexts) scrubbed.contexts = contexts;

  delete scrubbed.tags;
  if (typeof event.tags?.boundary === 'string') scrubbed.tags = { boundary: event.tags.boundary };

  if (event.request) {
    const request: NonNullable<Sentry.Event['request']> = {};
    if (typeof event.request.url === 'string') request.url = reduceUrl(event.request.url);
    if (event.request.method) request.method = event.request.method;
    scrubbed.request = request;
  }

  return scrubbed;
};

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    release: process.env.REACT_APP_VERSION,
    environment: process.env.NODE_ENV,
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },
    beforeSend(event) {
      return scrubEvent(event);
    },
  });
}

// Reached through reportBoundaryError in sentryReport.ts, the only route to this
// chunk that a component should use. The event goes through beforeSend above.
export const captureBoundaryError = (
  error: unknown,
  { boundary, componentStack }: { boundary: string; componentStack?: string | null },
): void => {
  Sentry.captureException(error, {
    tags: { boundary },
    ...(componentStack ? { contexts: { react: { componentStack } } } : {}),
  });
};
