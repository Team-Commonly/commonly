// The /api/health Redis check must pass REDIS_PASSWORD to the client so it can
// authenticate once the server requires AUTH (requirepass). A client left
// without the password breaks silently against an auth'd Redis, which is the
// exact failure mode this guards. The redis branch only runs when
// AGENT_PROVISIONER_K8S is set (see health.services.test.js), so set it here.

const request = require('supertest');
const express = require('express');

const mockCreateClient = jest.fn(() => ({
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  ping: jest.fn().mockResolvedValue('PONG'),
  disconnect: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('redis', () => ({ createClient: (...args) => mockCreateClient(...args) }));
jest.mock('../../../config/db-pg', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }), on: jest.fn() },
  connectPG: jest.fn(),
}));

const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

describe('GET /api/health — Redis AUTH wiring', () => {
  const ENV = ['AGENT_PROVISIONER_K8S', 'REDIS_PASSWORD', 'REDIS_HOST', 'REDIS_PORT'];
  const saved = {};
  beforeEach(() => {
    jest.clearAllMocks();
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    process.env.AGENT_PROVISIONER_K8S = '1'; // make the route exercise the Redis check
  });
  afterEach(() => {
    ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  it('passes the password to createClient when REDIS_PASSWORD is set', async () => {
    process.env.REDIS_PASSWORD = 's3cret-pw';
    await request(buildApp()).get('/api/health');
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ password: 's3cret-pw' }));
  });

  it('sends no password (undefined) when REDIS_PASSWORD is unset, so local no-auth Redis still works', async () => {
    delete process.env.REDIS_PASSWORD;
    await request(buildApp()).get('/api/health');
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ password: undefined }));
  });

  it('trims a trailing newline so the client authenticates against an auth-required Redis (the 2026-11-04 WRONGPASS)', async () => {
    process.env.REDIS_PASSWORD = 's3cret-pw\n';
    await request(buildApp()).get('/api/health');
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ password: 's3cret-pw' }));
  });
});
