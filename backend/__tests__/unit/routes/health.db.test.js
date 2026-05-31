// Unit test for the /api/health/db pool-status probe (#454 follow-up).
// Verifies the saturation signal (waiting > 0 AND idle === 0 → 503)
// and the OK shape (200 with pool stats payload).

const request = require('supertest');
const express = require('express');

// Hand-rolled pg pool stub so the test controls totalCount/idleCount/
// waitingCount and we can assert the response logic deterministically.
const mockPool = {
  options: { max: 50, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
  query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
  on: jest.fn(),
};

jest.mock('../../../config/db-pg', () => ({
  pool: mockPool,
  connectPG: jest.fn(),
}));

// process.env.PG_HOST needs to be truthy or the route returns
// not_configured. Set BEFORE the route module loads.
process.env.PG_HOST = process.env.PG_HOST || 'localhost-test';

const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRoutes);
  return app;
};

describe('GET /api/health/db', () => {
  beforeEach(() => {
    mockPool.totalCount = 0;
    mockPool.idleCount = 0;
    mockPool.waitingCount = 0;
  });

  it('returns 200 with pg stats when pool is idle (no waiters)', async () => {
    mockPool.totalCount = 3;
    mockPool.idleCount = 2;
    mockPool.waitingCount = 0;

    const res = await request(buildApp()).get('/api/health/db').expect(200);
    expect(res.body.pg).toEqual(expect.objectContaining({
      status: 'ok',
      max: 50,
      total: 3,
      idle: 2,
      waiting: 0,
      connectionTimeoutMillis: 5000,
    }));
  });

  it('returns 200 (not saturated) when waiting > 0 but idle > 0 (transient burst)', async () => {
    mockPool.totalCount = 10;
    mockPool.idleCount = 1;
    mockPool.waitingCount = 3;

    const res = await request(buildApp()).get('/api/health/db').expect(200);
    expect(res.body.pg.status).toBe('ok');
    expect(res.body.pg.waiting).toBe(3);
  });

  it('returns 503 (saturated) when waiting > 0 AND idle === 0', async () => {
    mockPool.totalCount = 50;
    mockPool.idleCount = 0;
    mockPool.waitingCount = 5;

    const res = await request(buildApp()).get('/api/health/db').expect(503);
    expect(res.body.pg).toEqual(expect.objectContaining({
      status: 'saturated',
      idle: 0,
      waiting: 5,
    }));
  });

  it('reports mongo state', async () => {
    const res = await request(buildApp()).get('/api/health/db').expect(200);
    expect(res.body.mongo).toEqual(expect.objectContaining({
      state: expect.any(String),
    }));
  });
});
