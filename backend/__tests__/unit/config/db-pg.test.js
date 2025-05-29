jest.mock('fs');

const fs = require('fs');

const mockClient = {
  query: jest.fn().mockResolvedValue({ rows: [{ version: '1' }] }),
  release: jest.fn(),
};

const mockPool = {
  connect: jest.fn().mockResolvedValue(mockClient),
  query: jest.fn(),
};

jest.mock('pg', () => ({
  Pool: jest.fn(() => mockPool),
}));

delete require.cache[require.resolve('../../../config/db-pg')];
const { pool, connectPG } = require('../../../config/db-pg');

describe('connectPG', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
  });

  it('returns the pool on successful connection', async () => {
    const result = await connectPG();
    expect(result).toBe(pool);
    expect(mockPool.connect).toHaveBeenCalled();
  });

  it('returns null on connection error', async () => {
    mockPool.connect.mockRejectedValueOnce(new Error('fail'));
    const result = await connectPG();
    expect(result).toBeNull();
  });
});
