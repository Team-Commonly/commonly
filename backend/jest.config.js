module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    // The whole helper directory, not a file-by-file list. Enumerating each
    // helper meant the list went stale the moment anyone added one — adding
    // __tests__/utils/schemaTable.js broke CI with "your test suite must
    // contain at least one test", and a targeted local run never sees it
    // because the file is only collected by a full sweep.
    // collectCoverageFrom below already treats this directory as non-test
    // (!**/__tests__/utils/**); this makes the two agree.
    '__tests__/utils/',
    '__tests__/setup.js',
  ],
  // Pre-download/cache the mongod binary ONCE before any worker starts so
  // parallel workers never race the download lock (the CI flake root cause).
  globalSetup: '<rootDir>/__tests__/utils/globalSetup.js',
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
