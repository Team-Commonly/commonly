// ADR-021 Part B took CLAWDBOT_GATEWAY_URL out of the chart. With it unset the
// route must answer "not configured" from the process, not probe an address
// nobody runs: the route is anonymous, and each hit used to make two requests.

const request = require('supertest');
const express = require('express');

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

describe('GET /api/health/clawdbot', () => {
  const savedUrl = process.env.CLAWDBOT_GATEWAY_URL;
  const savedFetch = global.fetch;

  beforeEach(() => {
    delete process.env.CLAWDBOT_GATEWAY_URL;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.CLAWDBOT_GATEWAY_URL;
    else process.env.CLAWDBOT_GATEWAY_URL = savedUrl;
  });

  it('says not_configured without a request when the URL is unset', async () => {
    const res = await request(buildApp()).get('/api/health/clawdbot');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still probes an operator-set URL', async () => {
    process.env.CLAWDBOT_GATEWAY_URL = 'http://gateway.example.test:18789';
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.2.3' }) });
    const res = await request(buildApp()).get('/api/health/clawdbot');
    expect(res.body).toMatchObject({ status: 'connected', version: '1.2.3' });
    expect(global.fetch).toHaveBeenCalledWith('http://gateway.example.test:18789/health', expect.anything());
  });
});
