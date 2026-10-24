const fsp = require('node:fs/promises');

const PATCHED = Symbol.for('commonly.mongoMemoryServerCleanup');
const SUITE_MANAGED = Symbol.for('commonly.mongoMemoryServerSuiteManaged');
const STARTUP_PATHS = Symbol.for('commonly.mongoMemoryServerStartupPaths');

const rememberPaths = (server, paths) => {
  if (!server[STARTUP_PATHS]) {
    Object.defineProperty(server, STARTUP_PATHS, { value: new Set() });
  }
  paths.filter((path) => typeof path === 'string').forEach((path) => {
    server[STARTUP_PATHS].add(path);
  });
};

const instancePaths = (server) => {
  let info;
  try {
    info = typeof server.getInstanceInfo === 'function'
      ? server.getInstanceInfo()
      : server._instanceInfo; // mongodb-memory-server 9.x fallback
  } catch (_) {
    info = server._instanceInfo;
  }

  return [...new Set([
    ...(server[STARTUP_PATHS] || []),
    info?.dbPath,
    info?.tmpDir,
  ].filter((value) => typeof value === 'string'))];
};

const removePaths = async (paths) => {
  await Promise.all(paths.map(async (path) => {
    try {
      await fsp.rm(path, { force: true, recursive: true });
    } catch (_) {
      // The library normally removes these paths. The exact-path fallback is
      // best effort so a cleanup race does not hide the test's real failure.
    }
  }));
};

// The shared testUtils helper has its own afterAll hook. Marking that server
// keeps this setup hook from stopping it first: setupFilesAfterEnv hooks are
// registered before a test file's hooks, so an unconditional global cleanup
// would close mongoose before the suite can clear its database.
const markMongoMemoryServerSuiteManaged = (server) => {
  if (server) server[SUITE_MANAGED] = true;
  return server;
};

const patchMongoMemoryServer = (MongoMemoryServer, tracked) => {
  if (!MongoMemoryServer || MongoMemoryServer[PATCHED]) return;

  const originalCreate = MongoMemoryServer.create;
  const originalGetStartOptions = MongoMemoryServer.prototype.getStartOptions;
  const originalStart = MongoMemoryServer.prototype.start;
  const originalStop = MongoMemoryServer.prototype.stop;

  MongoMemoryServer.create = async function create(...args) {
    const server = await originalCreate.apply(this, args);
    tracked.add(server);
    return server;
  };

  MongoMemoryServer.prototype.getStartOptions = async function getStartOptions(...args) {
    const options = await originalGetStartOptions.apply(this, args);
    // getStartOptions creates mongo-mem-* before MongoMemoryServer assigns
    // _instanceInfo. Capture that exact path even when a later startup step
    // rejects and leaves no instance info to inspect.
    rememberPaths(this, [options?.data?.dbPath, options?.data?.tmpDir]);
    return options;
  };

  MongoMemoryServer.prototype.start = async function start(...args) {
    try {
      return await originalStart.apply(this, args);
    } catch (error) {
      const paths = instancePaths(this);
      try {
        await originalStop.call(this, { doCleanup: true, force: true });
      } catch (_) {
        // Preserve the startup failure; the exact-path fallback still runs.
      }
      await removePaths(paths);
      throw error;
    }
  };

  MongoMemoryServer.prototype.stop = async function stop(options) {
    const paths = instancePaths(this);
    const cleanupOptions = {
      ...(options && typeof options === 'object' ? options : {}),
      doCleanup: true,
      force: true,
    };

    try {
      return await originalStop.call(this, cleanupOptions);
    } finally {
      tracked.delete(this);
      await removePaths(paths);
    }
  };

  Object.defineProperty(MongoMemoryServer, PATCHED, { value: true });
};

const installMongoMemoryServerCleanup = () => {
  if (globalThis.__commonlyMongoMemoryServerCleanupInstalled) return;
  globalThis.__commonlyMongoMemoryServerCleanupInstalled = true;

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const tracked = new Set();
  patchMongoMemoryServer(MongoMemoryServer, tracked);

  afterAll(async () => {
    const unowned = [...tracked].filter((server) => !server[SUITE_MANAGED]);
    await Promise.all(unowned.map((server) => server.stop({ doCleanup: true, force: true })));
  });
};

module.exports = { installMongoMemoryServerCleanup, markMongoMemoryServerSuiteManaged };
