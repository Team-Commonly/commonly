/* eslint-disable global-require */
const request = require('supertest');
const express = require('express');

jest.mock('../../config/db', () => jest.fn());

const mockConnectPG = jest.fn();
jest.mock('../../config/db-pg', () => ({ connectPG: mockConnectPG }));
const mockInitPGDB = jest.fn();
jest.mock('../../config/init-pg-db', () => mockInitPGDB);

// Replace pg routes with simple routers
jest.mock('../../routes/pg-status', () => {
  const ex = require('express');
  const r = ex.Router();
  r.get('/', (req, res) => res.json({ available: true }));
  return r;
});
jest.mock('../../routes/pg-pods', () => {
  const ex = require('express');
  return ex.Router();
});
jest.mock('../../routes/pg-messages', () => {
  const ex = require('express');
  return ex.Router();
});

describe('server pg status route', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.PG_HOST;
  });

  it('returns available:false when PG not configured', async () => {
    delete process.env.PG_HOST;
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });

  it('returns available:true when PG initialized', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockResolvedValue(true);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    // wait for async initialization
    await new Promise((resolve) => { setImmediate(resolve); });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: true });
  });

  it('returns available:false when PG connection fails', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue(null);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => { setImmediate(resolve); });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });

  it('returns available:false when PG init fails', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockResolvedValue(false);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => { setImmediate(resolve); });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });

  it('returns available:false when PG init throws', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockRejectedValue(new Error('fail'));
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => { setImmediate(resolve); });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });
});
