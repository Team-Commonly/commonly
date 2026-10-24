const fs = require('node:fs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MONGO_BINARY_VERSION, MONGOMS_DOWNLOAD_DIR } = require('../utils/mongoBinaryConfig');

test('removes a temp dbPath when startup fails before instance info exists', async () => {
  let createdTempDir;
  const originalGetStartOptions = MongoMemoryServer.prototype.getStartOptions;
  MongoMemoryServer.prototype.getStartOptions = async function getStartOptions(...args) {
    const options = await originalGetStartOptions.apply(this, args);
    createdTempDir = options.data.tmpDir;
    return options;
  };

  try {
    const server = new MongoMemoryServer({
      binary: {
        version: MONGO_BINARY_VERSION,
        downloadDir: MONGOMS_DOWNLOAD_DIR,
        skipMD5: true,
      },
      instance: {
        args: ['--commonly-invalid-startup-option'],
        launchTimeout: 2000,
      },
    });

    await expect(server.start()).rejects.toThrow();
  } finally {
    MongoMemoryServer.prototype.getStartOptions = originalGetStartOptions;
  }

  expect(typeof createdTempDir).toBe('string');
  expect(fs.existsSync(createdTempDir)).toBe(false);
});
