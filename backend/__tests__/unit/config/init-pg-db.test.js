/* eslint-disable import/no-unresolved, import/extensions */
jest.mock('fs');
// The unit under test is initializeDatabase; its pool dependency is stubbed. This
// suite previously reached for a REAL Pool object, which existed only because
// setup.js left PG_HOST as the truthy string 'undefined' and db-pg.ts:75 built a
// Pool for that host — so it broke the moment the harness stopped lying about the
// host, not because initializeDatabase changed (TASK-128).
jest.mock('../../../config/db-pg', () => ({ pool: { connect: jest.fn() } }));
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
