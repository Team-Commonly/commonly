// eslint-disable-next-line global-require
const mongoose = require('mongoose');
const { startMongoPoolStats } = require('../services/mongoPoolStats');

// MONGO_POOL_STATS=1 only: one `[mongo-pool]` line a minute says whether
// queries wait for a free pool connection (F636,
// docs/runbooks/mongo-pool-stats.md). It never fails the connect.
const maybeStartPoolStats = (): void => {
  if (process.env.MONGO_POOL_STATS !== '1') return;
  try {
    startMongoPoolStats(mongoose.connection.getClient());
    console.log('[mongo-pool] pool stats on');
  } catch (err) {
    console.error('[mongo-pool] pool stats failed to start:', err instanceof Error ? err.message : String(err));
  }
};

const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
    return;
  }
  maybeStartPoolStats();
};

module.exports = connectDB;

export {};
