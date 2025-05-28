jest.mock('../../../config/db-pg', () => {
  const mClient = { query: jest.fn().mockResolvedValue({ rows: [{ exists: true }] }), release: jest.fn() };
  const mPool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(mClient), end: jest.fn() };
  return { pool: mPool, connectPG: jest.fn(async () => mPool) };
});

const { pool, connectPG } = require('../../../config/db-pg');
const testConnection = require('../../../testPgConnection');

describe('testPgConnection', () => {
  it('connects and closes pool', async () => {
    await testConnection();
    expect(connectPG).toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalled();
  });
});
