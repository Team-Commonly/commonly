module.exports = {
  testEnvironment: 'node',
  // Cap worker fan-out on LOCAL runs only. A shared dev host (24 GB,
  // running many agent processes) breached on 2026-10-28 when an uncapped
  // backend jest run spun up cores-1 workers and pushed the host into swap thrash.
  // CI keeps the jest default (cores-1) via the CI guard — do NOT replace this with
  // a static maxWorkers, that would also throttle the runners.
  // The key is SPREAD IN, not set to `undefined` on CI: jest validates the config
  // and rejects `maxWorkers: undefined` ("has to be of type string or number"), so
  // on CI the key must be absent entirely, not present-and-undefined.
  ...(process.env.CI ? {} : { maxWorkers: 2 }),
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
    // The vendored record-v1 closure is ESM (byte-identical to
    // packages/seats/src); ts-jest down-levels it to CommonJS like tsc does.
    '/vendor/seats/.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, checkJs: false } }],
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
    '!vendor/**',
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
