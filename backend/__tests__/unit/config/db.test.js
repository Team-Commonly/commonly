const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const { startMongoPoolStats } = require('../../../services/mongoPoolStats');

jest.mock('mongoose', () => {
  const client = { on: jest.fn() };
  return {
    connect: jest.fn(),
    connection: { getClient: jest.fn(() => client) },
  };
});

jest.mock('../../../services/mongoPoolStats', () => ({
  startMongoPoolStats: jest.fn(() => ({ stop: jest.fn() })),
}));

describe('connectDB', () => {
  const saved = process.env.MONGO_POOL_STATS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MONGO_URI = 'mongodb://localhost/test';
    delete process.env.MONGO_POOL_STATS;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.MONGO_POOL_STATS;
    else process.env.MONGO_POOL_STATS = saved;
  });

  it('connects using mongoose with provided URI', async () => {
    await connectDB();
    expect(mongoose.connect).toHaveBeenCalledWith(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  });

  it('exits process when connection fails', async () => {
    mongoose.connect.mockRejectedValueOnce(new Error('fail'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    await connectDB();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  // F636: the pool stats log is opt-in; nothing changes when the flag is unset.
  it('does not start pool stats when MONGO_POOL_STATS is unset', async () => {
    await connectDB();
    expect(startMongoPoolStats).not.toHaveBeenCalled();
  });

  it('does not start pool stats for a value other than 1', async () => {
    process.env.MONGO_POOL_STATS = 'true';
    await connectDB();
    expect(startMongoPoolStats).not.toHaveBeenCalled();
  });

  it('starts pool stats on the mongoose client when MONGO_POOL_STATS=1', async () => {
    process.env.MONGO_POOL_STATS = '1';
    await connectDB();
    expect(startMongoPoolStats).toHaveBeenCalledTimes(1);
    expect(startMongoPoolStats).toHaveBeenCalledWith(mongoose.connection.getClient());
  });

  it('starts pool stats only after the connect resolves', async () => {
    process.env.MONGO_POOL_STATS = '1';
    let resolveConnect;
    mongoose.connect.mockReturnValueOnce(new Promise((resolve) => { resolveConnect = resolve; }));
    const pending = connectDB();
    await Promise.resolve();
    await Promise.resolve();
    expect(mongoose.connect).toHaveBeenCalledTimes(1);
    expect(startMongoPoolStats).not.toHaveBeenCalled();
    resolveConnect();
    await pending;
    expect(startMongoPoolStats).toHaveBeenCalledTimes(1);
  });

  it('never starts pool stats when the connect rejects', async () => {
    process.env.MONGO_POOL_STATS = '1';
    mongoose.connect.mockRejectedValueOnce(new Error('fail'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await connectDB();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(startMongoPoolStats).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('still resolves the connect when pool stats throws', async () => {
    process.env.MONGO_POOL_STATS = '1';
    startMongoPoolStats.mockImplementationOnce(() => { throw new Error('boom'); });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(connectDB()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[mongo-pool]'), expect.anything());
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
