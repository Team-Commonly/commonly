const testPG = require('../../../testPG');
const { pool } = require('../../../config/db-pg');

describe('testPG', () => {
  it('runs connection check', async () => {
    jest.spyOn(pool, 'query').mockResolvedValueOnce();
    jest.spyOn(pool, 'end').mockResolvedValue();
    await testPG();
    expect(pool.query).toHaveBeenCalledWith('SELECT NOW()');
  });
});
