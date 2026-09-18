const { MongoBinary } = require('mongodb-memory-server');
const { MONGO_BINARY_VERSION, MONGOMS_DOWNLOAD_DIR } = require('./mongoBinaryConfig');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Runs ONCE before any Jest worker spins up (configured via jest.config.js
// `globalSetup`). Pre-downloads/caches the mongod binary a single time so the
// per-file MongoMemoryServer.create() calls in parallel workers all reuse the
// cached binary and never race the download lock — the root cause of the flaky
// "Cannot unlock file ... .lock" failures in CI.
module.exports = async () => {
  // Name the remedy before the failure, because the failure does not. On Node
  // 25+ every suite whose require graph reaches jsonwebtoken dies with a bare
  // `TypeError: Cannot read properties of undefined (reading 'prototype')`
  // raised inside buffer-equal-constant-time — a package the test never
  // imports, four frames under jws. Measured cost of not saying this: a seat
  // read the stack, installed deps, wrote a SlowBuffer shim, and only then
  // found TESTING.md. One line here is cheaper than that detour.
  if (Number(process.versions.node.split('.')[0]) >= 25) {
    // console is not stubbed in this process (that happens per-worker in
    // setup.js), but stderr is the honest target either way.
    process.stderr.write(
      `[globalSetup] Node ${process.versions.node} removed buffer.SlowBuffer, which `
      + 'buffer-equal-constant-time reads at module scope — any suite reaching '
      + 'jsonwebtoken will fail to load. Run on Node 22 (what CI pins):\n'
      + '  PATH=/opt/homebrew/opt/node@22/bin:$PATH npx jest <suite>\n'
      + '  ...or without a local install: npx -y -p node@22 node node_modules/jest/bin/jest.js <suite>\n'
      + 'See backend/TESTING.md for the full picture.\n',
    );
  }

  // Integration runs use a real Mongo (MONGO_URI); no in-memory binary needed.
  if (process.env.INTEGRATION_TEST === 'true') return;

  // Pin the version + cache dir for this process AND for the child workers,
  // which inherit process.env. This keeps globalSetup and the per-file create()
  // pointed at the exact same cached binary.
  process.env.MONGOMS_VERSION = MONGO_BINARY_VERSION;
  process.env.MONGOMS_DOWNLOAD_DIR = MONGOMS_DOWNLOAD_DIR;

  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const binaryPath = await MongoBinary.getPath({
        version: MONGO_BINARY_VERSION,
        downloadDir: MONGOMS_DOWNLOAD_DIR,
      });
      // eslint-disable-next-line no-console
      console.log(`[globalSetup] mongod ${MONGO_BINARY_VERSION} cached at ${binaryPath}`);
      return;
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-console
      console.warn(`[globalSetup] mongod download attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(attempt * 2000);
      }
    }
  }

  throw lastError;
};
