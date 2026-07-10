/* eslint-disable global-require, import/no-unresolved, import/extensions */
const fs = require('fs');
const path = require('path');

const mockSentryInit = jest.fn();
const mockSetupExpressErrorHandler = jest.fn();

jest.mock('@sentry/node', () => ({
  init: mockSentryInit,
  setupExpressErrorHandler: mockSetupExpressErrorHandler,
}));

describe('Sentry backend instrumentation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_RELEASE;
    mockSentryInit.mockClear();
    mockSetupExpressErrorHandler.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('does not initialize or attach an error handler without a DSN', () => {
    const { attachSentryErrorHandler } = require('../../instrument');
    const app = {};

    attachSentryErrorHandler(app);

    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockSetupExpressErrorHandler).not.toHaveBeenCalled();
  });

  it('initializes with privacy-safe options and scrubs sensitive request data', () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/123';
    process.env.SENTRY_RELEASE = 'backend-sha';
    process.env.NODE_ENV = 'test-environment';

    const { attachSentryErrorHandler } = require('../../instrument');

    expect(mockSentryInit).toHaveBeenCalledTimes(1);
    const options = mockSentryInit.mock.calls[0][0];
    expect(options).toEqual(
      expect.objectContaining({
        dsn: process.env.SENTRY_DSN,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        release: 'backend-sha',
        environment: 'test-environment',
        beforeSend: expect.any(Function),
      }),
    );

    const event = {
      message: 'boom',
      user: { id: 'private-user' },
      request: {
        url: 'https://api.commonly.me/api/pods',
        method: 'GET',
        headers: { authorization: 'Bearer private-token' },
        cookies: { session: 'private-cookie' },
        data: { email: 'private@example.com', password: 'private-password' },
        query_string: 'token=private-token',
      },
    };
    const scrubbed = options.beforeSend(event);

    expect(scrubbed).toEqual({
      message: 'boom',
      request: {
        url: 'https://api.commonly.me/api/pods',
        method: 'GET',
      },
    });
    expect(event.user).toBeDefined();
    expect(event.request.headers).toBeDefined();
    expect(event.request.cookies).toBeDefined();
    expect(scrubbed.request.data).toBeUndefined();
    expect(scrubbed.request.query_string).toBeUndefined();

    const app = {};
    attachSentryErrorHandler(app);
    expect(mockSetupExpressErrorHandler).toHaveBeenCalledWith(app);
  });

  it('loads instrumentation first and attaches the error handler after routes', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '../../server.ts'), 'utf8');
    const firstLine = serverSource.split(/\r?\n/, 1)[0];
    const lastRoute = serverSource.lastIndexOf("app.use('/api/pg/status'");
    const handler = serverSource.lastIndexOf('attachSentryErrorHandler(app);');
    const socketMiddleware = serverSource.indexOf('// Socket.io middleware');

    expect(firstLine).toBe("const { attachSentryErrorHandler } = require('./instrument');");
    expect(handler).toBeGreaterThan(lastRoute);
    expect(handler).toBeLessThan(socketMiddleware);
  });
});
