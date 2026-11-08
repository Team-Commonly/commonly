// @ts-nocheck
// Runs the real SDK and sentry.ts end to end. Only the transport is replaced, so
// what these tests read is the envelope that would leave the browser.
const mockEnvelopes = [];

jest.mock('@sentry/react', () => {
  const actual = jest.requireActual('@sentry/react');
  return {
    ...actual,
    __esModule: true,
    init: (options) => actual.init({
      ...options,
      transport: () => ({
        send: async (envelope) => { mockEnvelopes.push(envelope); return {}; },
        flush: async () => true,
      }),
    }),
  };
});

const PLANTED = 'MADE-UP-VALUE-7f3a';
const originalEnv = { ...process.env };
let Sentry;
let reportBoundaryError;
let count = 0;
// The dedupe integration drops an event that repeats the one before it.
const nextError = () => { count += 1; return new Error(`plain ${count}`); };

const sentEvents = () => mockEnvelopes.flatMap(([, items]) => (
  items.filter(([header]) => header.type === 'event').map(([, payload]) => payload)
));

const expectNothingPlanted = async () => {
  await Sentry.flush(500);
  expect(sentEvents().length).toBeGreaterThan(0);
  expect(JSON.stringify(mockEnvelopes)).not.toContain(PLANTED);
};

beforeAll(() => {
  // Before init, so the SDK's console wrapper sits on top of the silent one.
  console.error = jest.fn();
  process.env = {
    ...originalEnv,
    REACT_APP_SENTRY_DSN: 'https://public@example.ingest.sentry.io/456',
    REACT_APP_VERSION: 'frontend-sha',
  };
  Sentry = require('@sentry/react');
  require('./sentry');
  ({ reportBoundaryError } = require('./sentryReport'));
});

beforeEach(() => {
  mockEnvelopes.length = 0;
  sessionStorage.clear();
  Sentry.getCurrentScope().clearBreadcrumbs();
  window.history.pushState({}, '', '/');
});

afterAll(() => {
  process.env = originalEnv;
});

describe('the envelope carries nothing planted in', () => {
  it.each([
    ['the reset page', `/v2/reset-password?token=${PLANTED}`],
    ['the invite page', `/v2/invite/${PLANTED}`],
    ['the oauth page', `/v2/oauth/complete?code=${PLANTED}`],
    ['the cli page', `/cli/authorize?code=${PLANTED}`],
    ['a nested return path', `/v2/register?next=%2Fregister%3Finvite%3D${PLANTED}`],
    ['a fragment', `/discord/success#install=${PLANTED}`],
    ['a person page', `/v2/profile/${PLANTED}`],
  ])('%s, as the page URL and a navigation', async (_label, url) => {
    window.history.pushState({}, '', url);
    window.history.pushState({}, '', '/v2/after');
    window.history.pushState({}, '', url);

    Sentry.captureException(nextError());

    await expectNothingPlanted();
  });

  it.each([
    ['the invite preview call', 'xhr', `/api/invites/${PLANTED}/preview`],
    ['the verify call', 'fetch', `/api/auth/verify-email?token=${PLANTED}`],
    ['an email link', 'fetch', `https://api.commonly.me/api/email/needs-you/open/${PLANTED}`],
  ])('%s, as a request breadcrumb', async (_label, category, url) => {
    Sentry.addBreadcrumb({ category, type: 'http', data: { method: 'GET', url, status_code: 500 } });

    Sentry.captureException(nextError());

    await expectNothingPlanted();
  });

  it('an error message, on the event and the next event\'s breadcrumb', async () => {
    Sentry.captureException(new Error(`failed for ${PLANTED}`));
    Sentry.captureException(nextError());

    await expectNothingPlanted();
    expect(sentEvents()).toHaveLength(2);
  });

  it('an error name', async () => {
    const error = nextError();
    error.name = PLANTED;

    Sentry.captureException(error);

    await expectNothingPlanted();
  });

  it('a cause chain', async () => {
    const root = new TypeError(`root ${PLANTED}`);
    const middle = new Error(`middle ${PLANTED}`, { cause: root });

    Sentry.captureException(new Error(`outer ${PLANTED}`, { cause: middle }));

    await expectNothingPlanted();
    expect(sentEvents()[0].exception.values).toHaveLength(3);
  });

  it('an aggregate error', async () => {
    Sentry.captureException(new AggregateError([new Error(`inner ${PLANTED}`)], `outer ${PLANTED}`));

    await expectNothingPlanted();
  });

  it('a thrown string', async () => {
    Sentry.captureException(`thrown ${PLANTED}`);

    await expectNothingPlanted();
  });

  it('a thrown object', async () => {
    Sentry.captureException({ reason: PLANTED, nested: { deeper: PLANTED } });

    await expectNothingPlanted();
  });

  it('a thrown object with a non-string message', async () => {
    Sentry.captureException({ message: { nested: PLANTED } });

    await expectNothingPlanted();
  });

  it('a captured message', async () => {
    Sentry.captureMessage(`said ${PLANTED}`);

    await expectNothingPlanted();
  });

  it('a console call', async () => {
    console.error('runtime error:', new Error(`logged ${PLANTED}`));

    Sentry.captureException(nextError());

    await expectNothingPlanted();
  });

  it('a clicked element\'s attributes', async () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', PLANTED);
    button.setAttribute('title', PLANTED);
    button.id = PLANTED;
    document.body.appendChild(button);
    button.click();
    button.remove();

    Sentry.captureException(nextError());

    await expectNothingPlanted();
  });

  it('a window error on a page with a planted URL', async () => {
    window.history.pushState({}, '', `/v2/reset-password?token=${PLANTED}`);

    window.dispatchEvent(new ErrorEvent('error', { message: `uncaught ${PLANTED}`, lineno: 1, colno: 1 }));

    await expectNothingPlanted();
  });

  it('frame variables, context lines, mechanism data, and every other event field', async () => {
    Sentry.captureEvent({
      message: PLANTED,
      logentry: { message: PLANTED, params: [PLANTED] },
      extra: { __serialized__: { reason: PLANTED } },
      fingerprint: [PLANTED],
      transaction: PLANTED,
      contexts: { madeUp: { reason: PLANTED } },
      request: { data: PLANTED, query_string: PLANTED, cookies: { a: PLANTED }, headers: { Referer: PLANTED } },
      exception: {
        values: [{
          type: PLANTED,
          value: PLANTED,
          mechanism: { type: 'generic', data: { handler: PLANTED }, description: PLANTED },
          stacktrace: {
            frames: [{
              filename: `https://commonly.me/v2/invite/${PLANTED}?token=${PLANTED}`,
              function: 'render',
              vars: { reason: PLANTED },
              pre_context: [PLANTED],
              context_line: PLANTED,
              post_context: [PLANTED],
            }],
          },
        }],
      },
    });

    await expectNothingPlanted();
  });

  it('a boundary report', async () => {
    window.history.pushState({}, '', `/v2/reset-password?token=${PLANTED}`);
    console.error('V2 runtime error:', new Error(`caught ${PLANTED}`));

    await reportBoundaryError(new Error(`caught ${PLANTED}`), { boundary: 'v2', componentStack: '\n    at Page' });

    await expectNothingPlanted();
  });
});

describe('the envelope still carries', () => {
  it('the tag, release, frames, component stack, and origin and path', async () => {
    window.history.pushState({}, '', '/v2/pods/123?tab=chat');

    await reportBoundaryError(new Error('a fresh crash'), { boundary: 'app', componentStack: '\n    at Page' });
    await Sentry.flush(500);

    const [event] = sentEvents();
    expect(event.tags).toEqual({ boundary: 'app' });
    expect(event.release).toBe('frontend-sha');
    expect(event.contexts.react.componentStack).toBe('\n    at Page');
    expect(event.request).toEqual({ url: 'http://localhost/v2/pods/123', method: undefined });
    const [exception] = event.exception.values;
    expect(exception.type).toBe('Error');
    expect(exception.stacktrace.frames.length).toBeGreaterThan(0);
    expect(exception.stacktrace.frames.at(-1)).toEqual(expect.objectContaining({
      filename: expect.any(String),
      lineno: expect.any(Number),
    }));
    expect(event.user).toBeUndefined();
    expect(event.sdk.settings.infer_ip).toBe('never');
    if (process.env.ENVELOPE_DUMP) {
      require('fs').writeFileSync(process.env.ENVELOPE_DUMP, JSON.stringify(mockEnvelopes, null, 1));
    }
  });
});
