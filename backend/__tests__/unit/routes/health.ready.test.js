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

// TASK-168: readiness asserts the PG mount from the route table. Default is
// mounted here so the three cases below stay about Mongo and the live probe;
// the mount gate has its own cases.
const mockPgRoutesAreMounted = jest.fn().mockReturnValue(true);
jest.mock('../../../services/pgBootService', () => ({
  pgRoutesAreMounted: (...args) => mockPgRoutesAreMounted(...args),
}));

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
    mockPgRoutesAreMounted.mockReturnValue(true);
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
    expect(res.body.degraded).toBeUndefined();
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

  it('stays ready with PostgreSQL marked degraded when the query fails', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      status: 'ready',
      degraded: ['postgresql'],
    }));
    expect(console.warn).toHaveBeenCalledWith(
      'health: PostgreSQL readiness check failed; continuing in Mongo fallback mode:',
      'connection refused',
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns not ready while the PostgreSQL routes are not mounted (TASK-168)', async () => {
    // The 2026-09-25 production defect: the boot connect timed out, the PG
    // routes were never mounted, chat history 404'd — and this handler answered
    // 200 because it only asked whether a live PG query worked, which the
    // lazily-created pool said yes to the moment the transient passed.
    mockPgRoutesAreMounted.mockReturnValue(false);

    const res = await request(buildApp()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual(expect.objectContaining({
      status: 'not_ready',
      reason: 'PostgreSQL routes are not mounted on this pod',
    }));
    // The mount is the whole answer, and it is taken before any live probe:
    // asking PG how it is feeling is what made this miss the outage.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('goes ready once the mount lands, with no restart (TASK-168)', async () => {
    // The retry mounts the routes in-place, so the same pod must flip ready
    // without being restarted — the half that made the incident need a human.
    mockPgRoutesAreMounted.mockReturnValue(false);
    await request(buildApp()).get('/api/health/ready').expect(503);

    mockPgRoutesAreMounted.mockReturnValue(true);
    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(res.body.status).toBe('ready');
    expect(mockPgRoutesAreMounted).toHaveBeenCalledTimes(2);
  });

  it('ignores the mount gate when PostgreSQL is not configured', async () => {
    // PG_HOST unset is a supported configuration, not a degraded pod: there is
    // no PG contract to have failed, so the gate must not apply.
    const saved = process.env.PG_HOST;
    delete process.env.PG_HOST;
    mockPgRoutesAreMounted.mockReturnValue(false);
    try {
      const res = await request(buildApp()).get('/api/health/ready').expect(200);
      expect(res.body.status).toBe('ready');
    } finally {
      process.env.PG_HOST = saved;
    }
  });
});
