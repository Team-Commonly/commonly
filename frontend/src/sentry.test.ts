import fs from 'fs';
import path from 'path';

const mockSentryInit = jest.fn();

jest.mock('@sentry/react', () => ({
  __esModule: true,
  init: mockSentryInit,
}));

const loadSentryModule = () => {
  jest.isolateModules(() => {
    require('./sentry');
  });
};

describe('Sentry frontend instrumentation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.REACT_APP_SENTRY_DSN;
    delete process.env.REACT_APP_VERSION;
    mockSentryInit.mockClear();
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
      },
    };
    const scrubbed = options.beforeSend(event);

    expect(scrubbed).toEqual({
      message: 'boom',
      request: {
        url: 'https://commonly.me/pods/123',
        method: 'GET',
      },
    });
    expect(event.user).toBeDefined();
    expect(event.request.headers).toBeDefined();
    expect(event.request.cookies).toBeDefined();
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
