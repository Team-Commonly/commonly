// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// Every upsert retries a lost unique-key race, as MongoDB does internally and
// FerretDB does not (see mongooseUpsertRetry). Installed before any query runs.
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
