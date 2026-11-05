// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// On FerretDB, every upsert retries a lost unique-key race, as MongoDB does
// internally (see mongooseUpsertRetry). Installed before any query runs; it
// probes buildInfo on connect and stays off against MongoDB.
require('./mongooseUpsertRetry');

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
  }
};

module.exports = connectDB;

export {};
