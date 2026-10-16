/**
 * /api/hosted's rate limiter, on its own (hosted.test.js passes it through,
 * because that file makes more requests than one minute's budget).
 *
 * Contract under test:
 *  - 30 requests a minute per bearer, then 429 with the stated message
 *  - a different bearer has its own budget
 *  - with no bearer, the key falls back to the client address Cloudflare reports
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'owner-1' };
  next();
});
jest.mock('../../../services/hostedRuntimeService', () => ({
  HOSTED_RUNTIME_TYPE: 'hosted',
  isConfigured: () => false,
  isHostedInstallation: () => false,
  hostedCaps: () => ({ agentsPerUser: 1, turnsPerDay: 30 }),
  hostedCapsForOwner: async () => ({ agentsPerUser: 1, turnsPerDay: 30 }),
}));
jest.mock('../../../services/nativeRuntimeService', () => ({
  isNativeRuntimeAvailable: () => false,
  hostedEngineAvailable: () => false,
}));
jest.mock('../../../services/onboardingMarks', () => ({ markByoOpened: jest.fn() }));

const hostedRouter = require('../../../routes/hosted');

const app = express();
app.use(express.json());
app.use('/api/hosted', hostedRouter);

const availability = (headers = {}) => request(app).get('/api/hosted/availability').set(headers);

describe('/api/hosted rate limiter', () => {
  it('allows 30 requests a minute per bearer, then answers 429, while another bearer still gets through', async () => {
    const statuses = [];
    for (let i = 0; i < 31; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await availability({ Authorization: 'Bearer owner-a' })).status);
    }
    expect(statuses.slice(0, 30).filter((status) => status === 429)).toEqual([]);
    const limited = await availability({ Authorization: 'Bearer owner-a' });
    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/30 hosted-runtime requests per 60s/);

    expect((await availability({ Authorization: 'Bearer owner-b' })).status).not.toBe(429);
  });

  it('with no bearer, keys on the client address Cloudflare reports', async () => {
    const statuses = [];
    for (let i = 0; i < 31; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await availability({ 'CF-Connecting-IP': '203.0.113.9' })).status);
    }
    expect(statuses.slice(0, 30).filter((status) => status === 429)).toEqual([]);
    expect(statuses[30]).toBe(429);
    expect((await availability({ 'CF-Connecting-IP': '203.0.113.10' })).status).not.toBe(429);
  });
});
