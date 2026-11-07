// Tier 1 drops the shared database in setupMongoDb, after connecting has already
// started each model's index build. A unique index lost that way fails only the
// tests that lean on it, and only when the drop wins the race (#3496's queue run).
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const StalledConnectEpisode = require('../../models/StalledConnectEpisode');

describe('setupMongoDb', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);

  it('leaves a loaded model its unique index', async () => {
    await StalledConnectEpisode.init();
    const indexes = await StalledConnectEpisode.collection.indexes();
    expect(indexes.filter((index) => index.unique)).not.toHaveLength(0);
  });
});
