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
  // In-memory mode — no real DB connections (default for unit tests)
  process.env.PG_HOST = undefined;
  process.env.MONGO_URI = undefined;
}
