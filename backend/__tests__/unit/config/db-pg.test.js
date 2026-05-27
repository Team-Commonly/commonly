jest.mock('fs');

const fs = require('fs');

const mockClient = {
  query: jest.fn().mockResolvedValue({ rows: [{ version: '1' }] }),
  release: jest.fn(),
};

const mockPool = {
  connect: jest.fn().mockResolvedValue(mockClient),
  query: jest.fn(),
  on: jest.fn(),
};

jest.mock('pg', () => ({
  Pool: jest.fn(() => mockPool),
}));

// db-pg.ts only constructs a Pool when PG_HOST is set; otherwise it
// returns null and `new Pool(...)` is never called. CI doesn't set
// PG_HOST in the unit-test job (only the Service Tests Tier 1 job
// boots real PG). Ensure a placeholder is present so the Pool ctor
// runs and our config assertions below have something to inspect.
process.env.PG_HOST = process.env.PG_HOST || 'localhost-test';

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

describe('Pool config (#454 incident — pool exhaustion)', () => {
  // Capture the constructor args passed to pg.Pool when db-pg.ts loads.
  // The mock above intercepts the constructor; reading
  // `require('pg').Pool.mock.calls[0][0]` gives us the config object the
  // backend would have handed to a real Pool.
  const getPoolArgs = () => require('pg').Pool.mock.calls[0][0];

  it('sets a default pool max well above pg.Pool default of 10', () => {
    const args = getPoolArgs();
    expect(args.max).toBeGreaterThanOrEqual(50);
  });

  it('sets a finite connectionTimeoutMillis (no infinite hang on saturation)', () => {
    const args = getPoolArgs();
    expect(args.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(args.connectionTimeoutMillis).toBeLessThanOrEqual(60_000);
  });
});
