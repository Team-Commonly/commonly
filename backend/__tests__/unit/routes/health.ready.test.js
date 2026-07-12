const request = require('supertest');
const express = require('express');

const mockMongoose = {
  connection: {
    readyState: 1,
  },
};
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
};
const mockCreateClient = jest.fn();

jest.mock('mongoose', () => mockMongoose);
jest.mock('redis', () => ({ createClient: mockCreateClient }));
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const originalPgHost = process.env.PG_HOST;
const originalK8sMode = process.env.AGENT_PROVISIONER_K8S;
process.env.PG_HOST = process.env.PG_HOST || 'localhost-test';
process.env.AGENT_PROVISIONER_K8S = '1';

// The backend source is TypeScript, while this legacy ESLint resolver only
// discovers JavaScript module extensions.
// eslint-disable-next-line import/no-unresolved, import/extensions
const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

describe('GET /api/health/ready', () => {
  beforeEach(() => {
    mockMongoose.connection.readyState = 1;
    mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
  });

  afterAll(() => {
    if (originalPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = originalPgHost;

    if (originalK8sMode === undefined) delete process.env.AGENT_PROVISIONER_K8S;
    else process.env.AGENT_PROVISIONER_K8S = originalK8sMode;
  });

  it('returns ready when MongoDB and PostgreSQL are available without probing Redis', async () => {
    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(res.body.status).toBe('ready');
    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns not ready while MongoDB is disconnected', async () => {
    mockMongoose.connection.readyState = 0;

    const res = await request(buildApp()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual({ status: 'not_ready', reason: 'MongoDB not connected' });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns not ready when PostgreSQL cannot answer the readiness query', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual({ status: 'not_ready', reason: 'PostgreSQL not connected' });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
