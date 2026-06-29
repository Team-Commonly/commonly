const path = require('path');

// Single source of truth for the mongod binary version used by BOTH the Jest
// globalSetup pre-download and the per-file MongoMemoryServer.create() call.
// Keep these in lock-step so parallel workers all resolve the SAME cached
// binary and never race each other downloading/locking a different version.
const MONGO_BINARY_VERSION = '7.0.14';

// Stable, shared cache dir so every worker reuses one binary instead of each
// resolving its own download/lock. Lives under node_modules so it is gitignored
// and survives across test runs in CI cache.
const MONGOMS_DOWNLOAD_DIR = path.resolve(__dirname, '..', '..', 'node_modules', '.cache', 'mongodb-binaries');

module.exports = {
  MONGO_BINARY_VERSION,
  MONGOMS_DOWNLOAD_DIR,
};
