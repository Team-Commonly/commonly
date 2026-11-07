// Tier 1 drops the shared database in setupMongoDb, after connecting has already
// started each model's index build. If the build finishes first, the drop takes
// the index, and a test leaning on a unique index fails for the whole file, as
// #3496's queue run did. Setting up a second time with the model's build already
// done is that case every time, and needs no Tier 1 job to go red.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const StalledConnectEpisode = require('../../models/StalledConnectEpisode');

describe('setupMongoDb against a shared database', () => {
  const { INTEGRATION_TEST, MONGO_URI } = process.env;

  beforeAll(async () => {
    await setupMongoDb();
    await StalledConnectEpisode.init();
  });
  afterAll(closeMongoDb);

  it('keeps a unique index whose build beat the drop', async () => {
    // The string it connected with: credentials and authSource come along.
    const uri = mongoose.connection._connectionString;
    expect(uri).toEqual(expect.any(String));
    await mongoose.disconnect();
    process.env.INTEGRATION_TEST = 'true';
    process.env.MONGO_URI = uri;
    try {
      await setupMongoDb();
    } finally {
      process.env.INTEGRATION_TEST = INTEGRATION_TEST;
      process.env.MONGO_URI = MONGO_URI;
      if (INTEGRATION_TEST === undefined) delete process.env.INTEGRATION_TEST;
      if (MONGO_URI === undefined) delete process.env.MONGO_URI;
    }

    const indexes = await StalledConnectEpisode.collection.indexes();
    expect(indexes.filter((index) => index.unique).map((index) => Object.keys(index.key)))
      .toContainEqual(['installationId', 'tokenIssuedAt']);
  });
});
