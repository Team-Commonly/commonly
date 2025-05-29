const { pool } = require('../../../config/db-pg');
const addColumn = require('../../../add-message-type');

jest.mock('../../../config/db-pg', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

describe('add-message-type migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adds column when missing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await addColumn();
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toMatch(/ALTER TABLE messages/);
  });

  it('does nothing when column exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}] });
    await addColumn();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
