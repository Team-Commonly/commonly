const path = require('path');

// Single source of truth for the mongod binary version used by BOTH the Jest
// globalSetup pre-download and the per-file MongoMemoryServer.create() call.
// Keep these in lock-step so parallel workers all resolve the SAME cached
// binary and never race each other downloading/locking a different version.
const MONGO_BINARY_VERSION = '7.0.14';

// Stable, shared cache dir so every worker reuses one binary instead of each
// resolving its own download/lock. Lives under node_modules so it is gitignored
// and persists across local runs. It is NOT a CI cache: no workflow references
// this or any MONGOMS_* variable, and the only `cache:` key in the test job is
// setup-node's `~/.npm` (measured 2026-09-26) — so a cold runner warms this dir
// exactly once, in globalSetup, before any worker exists. A test that pins its
// own version misses that warm-up and downloads during the worker phase.
const MONGOMS_DOWNLOAD_DIR = path.resolve(__dirname, '..', '..', 'node_modules', '.cache', 'mongodb-binaries');

module.exports = {
  MONGO_BINARY_VERSION,
  MONGOMS_DOWNLOAD_DIR,
};
