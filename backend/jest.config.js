module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    '__tests__/utils/testUtils.js',
    '__tests__/setup.js',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { allowJs: true, checkJs: false } }],
    '^.+\\.jsx?$': 'babel-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    '**/*.{js,ts}',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/jest.config.js',
    '!**/__tests__/utils/**',
    '!server.ts',
    '!server.js',
  ],
  verbose: true,
  // Increase timeouts for database setup
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  // Handle module mocking better
  clearMocks: true,
  restoreMocks: true,
};
