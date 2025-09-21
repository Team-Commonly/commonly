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

// Mock process.env.PG_HOST to prevent real PostgreSQL connections in unit tests
if (!process.env.INTEGRATION_TEST) {
  process.env.PG_HOST = undefined;
}

// Mock Mongoose models to prevent real MongoDB connections in unit tests
if (!process.env.INTEGRATION_TEST) {
  // Set MONGO_URI to undefined to prevent real connections
  process.env.MONGO_URI = undefined;
}