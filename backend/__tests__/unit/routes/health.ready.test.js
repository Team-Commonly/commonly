const request = require('supertest');
const express = require('express');

const mockMongoose = {
  connection: {
    readyState: 1,
    db: {
      admin: () => ({
        ping: jest.fn().mockResolvedValue({ ok: 1 }),
      }),
    },
  },
};

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

jest.mock('mongoose', () => mockMongoose);

process.env.PG_HOST = process.env.PG_HOST || 'localhost-test';

const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRoutes);
  return app;
};

describe('GET /api/health/ready', () => {
  const originalAgentProvisioner = process.env.AGENT_PROVISIONER_K8S;

  beforeEach(() => {
    mockPool.totalCount = 0;
    mockPool.idleCount = 0;
    mockPool.waitingCount = 0;
    mockPool.query.mockClear();
    process.env.AGENT_PROVISIONER_K8S = '0';
  });

  afterAll(() => {
    process.env.AGENT_PROVISIONER_K8S = originalAgentProvisioner;
  });

  it('returns 503 immediately when the PG pool is saturated', async () => {
    mockPool.totalCount = 50;
    mockPool.idleCount = 0;
    mockPool.waitingCount = 4;

    const res = await request(buildApp()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual(expect.objectContaining({
      status: 'not_ready',
      reason: 'PostgreSQL pool saturated',
      pg: expect.objectContaining({
        max: 50,
        total: 50,
        idle: 0,
        waiting: 4,
        connectionTimeoutMillis: 5000,
      }),
    }));
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('checks PostgreSQL normally when the pool is not saturated', async () => {
    mockPool.totalCount = 10;
    mockPool.idleCount = 2;
    mockPool.waitingCount = 0;

    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ready',
    }));
  });
});
