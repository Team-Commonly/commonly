// Global test setup
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

// Suppress console logs during tests unless needed
if (process.env.TEST_VERBOSE !== 'true') {
  const originalConsole = console;
  global.console = {
    ...console,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  };

  // Keep actual console for test debugging
  global.originalConsole = originalConsole;
}

// Set longer timeout for database operations
jest.setTimeout(30000);

if (process.env.INTEGRATION_TEST) {
  // Connect to real services — expects Docker Compose dev stack running:
  //   ./dev.sh up   (starts mongo on :27017 and postgres on :5432)
  process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/commonly-test';
  process.env.PG_HOST = process.env.PG_HOST || 'localhost';
  process.env.PG_PORT = process.env.PG_PORT || '5432';
  process.env.PG_DATABASE = process.env.PG_DATABASE || 'commonly-test';
  process.env.PG_USER = process.env.PG_USER || 'postgres';
  process.env.PG_PASSWORD = process.env.PG_PASSWORD || 'postgres';
  process.env.PG_SSL_ENABLED = 'false';
} else {
  // In-memory mode — no real DB connections (default for unit tests).
  // DELETE the keys; do not assign `undefined`. Assignment stores the STRING
  // 'undefined', which is truthy, so every `if (process.env.PG_HOST)` guard in
  // the backend takes the configured branch — 25 reads across 11 runtime
  // modules, including server.ts:68/:378, podController.ts:22/:462/:663,
  // authController.ts:171 and agentsRuntime.ts:3188 — and db-pg.ts:75 builds a
  // real Pool for host 'undefined' instead of taking connectPG's not-configured
  // path at :106-108. Measured: PG_HOST read back as the string "undefined" at
  // module scope in a file that never touched it.
  delete process.env.PG_HOST;
  delete process.env.MONGO_URI;
}
