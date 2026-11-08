import fs from 'fs';
import path from 'path';

const mockSentryInit = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@sentry/react', () => ({
  __esModule: true,
  init: mockSentryInit,
  captureException: mockCaptureException,
}));

const loadSentryModule = () => {
  let loaded;
  jest.isolateModules(() => {
    loaded = require('./sentry');
  });
  return loaded;
};

describe('Sentry frontend instrumentation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.REACT_APP_SENTRY_DSN;
    delete process.env.REACT_APP_VERSION;
    mockSentryInit.mockClear();
    mockCaptureException.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('does not initialize without a DSN', () => {
    loadSentryModule();

    expect(mockSentryInit).not.toHaveBeenCalled();
  });

  it('initializes with privacy-safe options and scrubs sensitive request data', () => {
    process.env.REACT_APP_SENTRY_DSN = 'https://public@example.ingest.sentry.io/456';
    process.env.REACT_APP_VERSION = 'frontend-sha';

    loadSentryModule();

    expect(mockSentryInit).toHaveBeenCalledTimes(1);
    const options = mockSentryInit.mock.calls[0][0];
    expect(options).toEqual(
      expect.objectContaining({
        dsn: process.env.REACT_APP_SENTRY_DSN,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        release: 'frontend-sha',
        environment: process.env.NODE_ENV,
        beforeBreadcrumb: expect.any(Function),
        beforeSend: expect.any(Function),
      }),
    );

    const event = {
      message: 'boom',
      user: { id: 'private-user' },
      request: {
        url: 'https://commonly.me/pods/123',
        method: 'GET',
        headers: { authorization: 'Bearer private-token' },
        cookies: { session: 'private-cookie' },
        data: { email: 'private@example.com', password: 'private-password' },
        query_string: 'token=private-token',
      },
    };
    const scrubbed = options.beforeSend(event);

    expect(scrubbed).toEqual({
      request: {
        url: 'https://commonly.me/pods/123',
        method: 'GET',
      },
    });
    expect(event.user).toBeDefined();
    expect(event.request.headers).toBeDefined();
    expect(event.request.cookies).toBeDefined();
    expect(event.message).toBe('boom');
  });

  const eventOptions = () => {
    process.env.REACT_APP_SENTRY_DSN = 'https://public@example.ingest.sentry.io/456';
    loadSentryModule();
    return mockSentryInit.mock.calls[0][0];
  };

  describe('URLs keep their origin and path', () => {
    it.each([
      ['the reset page', 'https://commonly.me/v2/reset-password?token=MADE-UP', 'https://commonly.me/v2/reset-password'],
      ['the invite page', 'https://commonly.me/v2/invite/MADE-UP', 'https://commonly.me/v2/invite/[masked]'],
      ['the oauth page', 'https://commonly.me/v2/oauth/complete?code=MADE-UP', 'https://commonly.me/v2/oauth/complete'],
      ['the cli page', 'https://commonly.me/cli/authorize?code=MADE-UP', 'https://commonly.me/cli/authorize'],
      ['a nested return path', '/v2/register?next=%2Fregister%3Finvite%3DMADE-UP', '/v2/register'],
      ['a fragment', '/discord/success#install=MADE-UP', '/discord/success'],
      ['a query and a fragment', '/v2/register?next=%2Fv2#section', '/v2/register'],
      ['the invite preview call', '/api/invites/MADE-UP/preview', '/api/invites/[masked]/preview'],
      ['the verify call', '/api/auth/verify-email?token=MADE-UP', '/api/auth/verify-email'],
      ['the email open link', '/api/email/needs-you/open/MADE-UP', '/api/email/needs-you/open/[masked]'],
      ['the email unsubscribe link', '/api/email/unsubscribe/MADE-UP', '/api/email/unsubscribe/[masked]'],
      ['the nudge unsubscribe link', '/api/email/unsubscribe/needs-you/MADE-UP', '/api/email/unsubscribe/needs-you/[masked]'],
      ['a person page', '/v2/profile/MADE-UP', '/v2/profile/[masked]'],
      ['a person call', '/api/users/MADE-UP/follow', '/api/users/[masked]/follow'],
      ['an upload', '/api/uploads/MADE-UP/url', '/api/uploads/[masked]/url'],
      ['a protocol-relative URL', '//commonly.me/v2/invite/MADE-UP?x=1', '//commonly.me/v2/invite/[masked]'],
      ['a URL with userinfo', 'https://name:MADE-UP@commonly.me/x', 'https://commonly.me/x'],
      ['a data URL', 'data:text/plain;base64,MADE-UP', 'data:'],
      ['a route that only sounds like one', '/v2/register/invite-required', '/v2/register/invite-required'],
      ['a plain route', 'https://commonly.me/v2/pods/123', 'https://commonly.me/v2/pods/123'],
      ['a frame with no URL', '<anonymous>', '<anonymous>'],
    ])('for %s', (_label, raw, kept) => {
      const options = eventOptions();

      expect(options.beforeSend({ request: { url: raw } }).request.url).toBe(kept);
      expect(options.beforeBreadcrumb({ category: 'navigation', data: { from: raw, to: raw } }).data)
        .toEqual({ from: kept, to: kept });
      expect(options.beforeBreadcrumb({ category: 'xhr', data: { url: raw } }).data.url).toBe(kept);
      expect(options.beforeSend({ breadcrumbs: [{ category: 'fetch', data: { url: raw } }] }).breadcrumbs[0].data.url)
        .toBe(kept);

      const frame = options.beforeSend({
        exception: { values: [{ stacktrace: { frames: [{ filename: raw, abs_path: raw, lineno: 1 }] } }] },
      }).exception.values[0].stacktrace.frames[0];
      expect(frame).toEqual({ filename: kept, abs_path: kept, lineno: 1 });
    });
  });

  describe('an error event keeps its location and no text', () => {
    it('sends every exception value as one fixed string', () => {
      const options = eventOptions();
      const event = {
        exception: { values: [{ type: 'Error', value: 'one' }, { type: 'Error', value: 'two' }, { type: 'Error' }] },
      };

      const { values } = options.beforeSend(event).exception;

      expect(new Set(values.map(({ value }) => value)).size).toBe(1);
      expect(values[0].value).toEqual(expect.any(String));
      expect(values[0].value).not.toMatch(/one|two/);
      expect(event.exception.values[0].value).toBe('one');
    });

    it.each([
      ['Error'], ['TypeError'], ['RangeError'], ['ReferenceError'], ['SyntaxError'],
      ['URIError'], ['EvalError'], ['AggregateError'],
    ])('keeps the built-in type %s', (type) => {
      const scrubbed = eventOptions().beforeSend({ exception: { values: [{ type, value: 'x' }] } });

      expect(scrubbed.exception.values[0].type).toBe(type);
    });

    it.each([
      ['a custom name', 'MadeUpError'],
      ['a name built from data', 'Failed for someone@example.com'],
      ['no name', undefined],
      ['a non-string name', { nested: 'x' }],
    ])('sends Error for %s', (_label, type) => {
      const scrubbed = eventOptions().beforeSend({ exception: { values: [{ type, value: 'x' }] } });

      expect(scrubbed.exception.values[0].type).toBe('Error');
    });

    it.each([
      ['a string message', { message: 'made up' }],
      ['an object message', { message: { nested: 'made up' } }],
      ['a logentry', { logentry: { message: 'made up %s', params: ['x'] } }],
      ['extra data', { extra: { __serialized__: { reason: 'made up' } } }],
      ['a transaction name', { transaction: '/v2/invite/made-up' }],
      ['a fingerprint', { fingerprint: ['made up'] }],
    ])('drops %s', (_label, event) => {
      expect(eventOptions().beforeSend(event)).toEqual({});
    });

    it('keeps only named mechanism fields', () => {
      const scrubbed = eventOptions().beforeSend({
        exception: {
          values: [{
            mechanism: {
              type: 'generic',
              handled: true,
              synthetic: true,
              source: 'cause',
              exception_id: 1,
              parent_id: 0,
              is_exception_group: false,
              data: { handler: 'made up' },
              description: 'made up',
              help_link: 'made up',
              meta: { errno: 'made up' },
            },
          }],
        },
      });

      expect(scrubbed.exception.values[0].mechanism).toEqual({
        type: 'generic',
        handled: true,
        synthetic: true,
        source: 'cause',
        exception_id: 1,
        parent_id: 0,
        is_exception_group: false,
      });
    });

    it('keeps only named frame fields', () => {
      const frame = {
        filename: 'https://commonly.me/assets/a.js',
        abs_path: 'https://commonly.me/assets/a.js',
        function: 'render',
        lineno: 3,
        colno: 9,
        in_app: true,
      };
      const scrubbed = eventOptions().beforeSend({
        exception: {
          values: [{
            stacktrace: {
              frames: [{
                ...frame,
                vars: { secret: 'made up' },
                pre_context: ['made up'],
                context_line: 'made up',
                post_context: ['made up'],
              }],
            },
          }],
        },
      });

      expect(scrubbed.exception.values[0].stacktrace).toEqual({ frames: [frame] });
    });

    it('keeps the tag, release, component stack and no other context', () => {
      const scrubbed = eventOptions().beforeSend({
        release: 'frontend-sha',
        tags: { boundary: 'v2' },
        contexts: {
          react: { componentStack: '\n    at Page' },
          trace: { trace_id: 'abc' },
          madeUp: { reason: 'made up' },
        },
      });

      expect(scrubbed).toEqual({
        release: 'frontend-sha',
        tags: { boundary: 'v2' },
        contexts: {
          react: { componentStack: '\n    at Page' },
          trace: { trace_id: 'abc' },
        },
      });
    });
  });

  describe('breadcrumbs keep their category and location', () => {
    it.each([['console'], ['sentry.event'], ['ui.click'], ['ui.input']])('with no message for %s', (category) => {
      const options = eventOptions();

      expect(options.beforeBreadcrumb({ category, message: 'made up' })).toEqual({ category });
      expect(options.beforeSend({ breadcrumbs: [{ category, message: 'made up' }] }).breadcrumbs)
        .toEqual([{ category }]);
    });

    it('with no raw console arguments', () => {
      const breadcrumb = eventOptions().beforeBreadcrumb({
        category: 'console',
        level: 'error',
        data: { arguments: ['made up', new Error('made up')], logger: 'console' },
      });

      expect(breadcrumb).toEqual({ category: 'console', level: 'error', data: { logger: 'console' } });
    });
  });

  it('captures a boundary error with its tag and component stack', () => {
    process.env.REACT_APP_SENTRY_DSN = 'https://public@example.ingest.sentry.io/456';
    const { captureBoundaryError } = loadSentryModule();
    const error = new Error('boom');

    captureBoundaryError(error, { boundary: 'v2', componentStack: '\n    at Broken' });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { boundary: 'v2' },
      contexts: { react: { componentStack: '\n    at Broken' } },
    });
  });

  it('keeps the SDK out of the eager modules the boundaries import', () => {
    const importsSdk = /from\s+['"](?:@sentry\/react|\.{1,2}(?:\/\.\.)*\/sentry)['"]/;
    const reportSource = fs.readFileSync(path.join(__dirname, 'sentryReport.ts'), 'utf8');
    const appSource = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
    const v2Source = fs.readFileSync(path.join(__dirname, 'v2/V2App.tsx'), 'utf8');

    expect(reportSource).toContain("await import('./sentry')");
    for (const source of [reportSource, appSource, v2Source]) {
      expect(source).not.toMatch(importsSdk);
    }
    expect(appSource).toContain("import { reportBoundaryError } from './sentryReport'");
    expect(v2Source).toContain("import { reportBoundaryError } from '../sentryReport'");
  });

  it('loads the SDK only through the DSN-gated dynamic import', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
    const viteSource = fs.readFileSync(path.join(__dirname, '../vite.config.ts'), 'utf8');

    expect(indexSource).toMatch(
      /if \(process\.env\.REACT_APP_SENTRY_DSN\) \{\s*import\('\.\/sentry'\);\s*\}/,
    );
    expect(viteSource).toContain("'process.env.REACT_APP_SENTRY_DSN': JSON.stringify(");
  });
});
