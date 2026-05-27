jest.mock('fs');

// db-pg.ts only constructs a Pool when PG_HOST is set; otherwise it
// returns null and `new Pool(...)` is never called. CI doesn't set
// PG_HOST in the unit-test job (only the Service Tests Tier 1 job
// boots real PG). Ensure a placeholder is present BEFORE jest.mock
// hoists/the module is required so the Pool ctor path runs.
process.env.PG_HOST = process.env.PG_HOST || 'localhost-test';

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

// Capture the Pool constructor args module-side. Relying on
// `require('pg').Pool.mock.calls[0][0]` is fragile because each
// `require('pg')` inside this file goes through the jest.mock factory,
// which (on some jest versions) returns a fresh module exports object
// each time — `.mock.calls` on the version we look at can be empty
// while the version db-pg.ts saw recorded the call. A captured
// variable sidesteps the indirection entirely.
let capturedPoolArgs = null;

jest.mock('pg', () => ({
  Pool: jest.fn((args) => {
    capturedPoolArgs = args;
    return mockPool;
  }),
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

describe('Pool config (#454 incident — pool exhaustion)', () => {
  // capturedPoolArgs (defined at the top of the file) is populated by
  // the mocked pg.Pool factory when db-pg.ts constructs its pool.
  it('captures the Pool ctor args (sanity guard)', () => {
    expect(capturedPoolArgs).not.toBeNull();
    expect(typeof capturedPoolArgs).toBe('object');
  });

  it('sets a default pool max well above pg.Pool default of 10', () => {
    expect(capturedPoolArgs.max).toBeGreaterThanOrEqual(50);
  });

  it('sets a finite connectionTimeoutMillis (no infinite hang on saturation)', () => {
    expect(capturedPoolArgs.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(capturedPoolArgs.connectionTimeoutMillis).toBeLessThanOrEqual(60_000);
  });
});
