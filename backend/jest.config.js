module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    '__tests__/utils/testUtils.js',
  ],
  collectCoverageFrom: [
    '**/*.js',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/jest.config.js',
    '!**/__tests__/utils/**',
    '!server.js',
  ],
  verbose: true,
};
