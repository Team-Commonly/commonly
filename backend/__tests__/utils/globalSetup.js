const { MongoBinary } = require('mongodb-memory-server');
const { MONGO_BINARY_VERSION, MONGOMS_DOWNLOAD_DIR } = require('./mongoBinaryConfig');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Runs ONCE before any Jest worker spins up (configured via jest.config.js
// `globalSetup`). Pre-downloads/caches the mongod binary a single time so the
// per-file MongoMemoryServer.create() calls in parallel workers all reuse the
// cached binary and never race the download lock — the root cause of the flaky
// "Cannot unlock file ... .lock" failures in CI.
module.exports = async () => {
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
