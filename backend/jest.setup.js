// Set up environment variables for testing
process.env.NODE_ENV = 'test';

// Use the test JWT secret from environment if available, otherwise use a default
process.env.JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret';

// Use the test MongoDB URI from environment if available, otherwise use a default local one
process.env.MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test';

// Port for testing
process.env.PORT = process.env.TEST_PORT || '5001';

// Increase timeout for tests
jest.setTimeout(30000);

// Suppress console output during tests to keep test output clean
// You can comment these out if you need to debug tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Additional environment variables
process.env.PG_USER = 'test';
process.env.PG_PASSWORD = 'test';
process.env.PG_HOST = 'localhost';
process.env.PG_PORT = '5432';
process.env.PG_DATABASE = 'test';
process.env.SENDGRID_API_KEY = 'fake-api-key';
process.env.SENDGRID_FROM_EMAIL = 'test@example.com';
process.env.FRONTEND_URL = 'http://localhost:3000';

// Silence console logs during tests
console.log = jest.fn();
console.info = jest.fn();
console.warn = jest.fn();
// Keep error logs for debugging
// console.error = jest.fn(); 