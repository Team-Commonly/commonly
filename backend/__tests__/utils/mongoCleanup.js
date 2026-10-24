const fs = require('node:fs/promises');

const PATCHED = Symbol.for('commonly.mongoMemoryServerCleanup');

const instancePaths = (server) => {
  let info;
  try {
    info = typeof server.getInstanceInfo === 'function'
      ? server.getInstanceInfo()
      : server._instanceInfo; // mongodb-memory-server 9.x fallback
  } catch (_) {
    info = server._instanceInfo;
  }

  return [...new Set([info?.dbPath, info?.tmpDir].filter((value) => typeof value === 'string'))];
};

const removePaths = async (paths) => {
  await Promise.all(paths.map(async (path) => {
    try {
      await fs.rm(path, { force: true, recursive: true });
    } catch (_) {
      // The library normally removes these paths. The exact-path fallback is
      // best effort so a cleanup race does not hide the test's real failure.
    }
  }));
};

const patchMongoMemoryServer = (MongoMemoryServer, tracked) => {
  if (!MongoMemoryServer || MongoMemoryServer[PATCHED]) return;

  const originalCreate = MongoMemoryServer.create;
  const originalStart = MongoMemoryServer.prototype.start;
  const originalStop = MongoMemoryServer.prototype.stop;

  MongoMemoryServer.create = async function create(...args) {
    const server = await originalCreate.apply(this, args);
    tracked.add(server);
    return server;
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
    await Promise.all([...tracked].map((server) => server.stop({ doCleanup: true, force: true })));
  });
};

module.exports = { installMongoMemoryServerCleanup };
