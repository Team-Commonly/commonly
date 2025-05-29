jest.mock('fs');
const fs = require('fs');
const { pool } = require('../../../config/db-pg');

delete require.cache[require.resolve('../../../config/init-pg-db')];
const initDb = require('../../../config/init-pg-db');

describe('initializeDatabase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('executes schema when file exists', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('SQL');
    const client = { query: jest.fn(), release: jest.fn() };
    pool.connect = jest.fn().mockResolvedValue(client);
    const result = await initDb();
    expect(client.query).toHaveBeenCalledWith('SQL');
    expect(result).toBe(true);
  });

  it('returns false when schema file missing', async () => {
    fs.existsSync.mockReturnValue(false);
    const client = { release: jest.fn() };
    pool.connect = jest.fn().mockResolvedValue(client);
    const result = await initDb();
    expect(result).toBe(false);
  });
});
