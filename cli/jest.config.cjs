// Jest config lives here, not in package.json, so maxWorkers can be guarded by CI.
// A shared dev host (24 GB, running many agent seats + operator sessions) breached
// on 2026-10-28 when uncapped jest runs spun up cores-1 workers and pushed the host
// into swap thrash. Local runs cap at 2 workers; CI keeps the jest default (cores-1)
// for speed via the CI guard. Do NOT replace the guard with a static maxWorkers —
// that would also throttle the runners.
//
// This file is .cjs (not .js) because cli/package.json is "type": "module", so a bare
// .js here would be loaded as ESM and `module.exports` would fail.
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  setupFilesAfterEnv: ['<rootDir>/jest.teardown.cjs'],
  transform: {},
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/__tests__/**/*.mjs',
    '**/?(*.)+(spec|test).[jt]s?(x)',
    '**/?(*.)+(spec|test).mjs',
  ],
  // Spread the key in rather than setting it to `undefined` on CI: jest validates
  // the config and rejects `maxWorkers: undefined` ("has to be of type string or
  // number"), so on CI the key must be absent entirely, not present-and-undefined.
  ...(process.env.CI ? {} : { maxWorkers: 2 }),
};
