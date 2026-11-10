const express = require('express');
const request = require('supertest');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

// The limiters skip under NODE_ENV=test unless this is set, so the other usage
// suites can send freely. Set before the router loads.
process.env.USAGE_LIMITS_IN_TEST = '1';
const User = require('../../models/User');
const { issueSessionToken } = require('../../services/sessionTokenService');

describe('usage event limits', () => {
  let app;
  beforeAll(async () => {
    process.env.JWT_SECRET = 'usage-events-test';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/stats', require('../../routes/stats'));
  });
  afterAll(async () => {
    delete process.env.USAGE_LIMITS_IN_TEST;
    await clearMongoDb();
    await closeMongoDb();
  });

  it('limits logged-out hits to 60 a minute per IP', async () => {
    const send = () => request(app).post('/api/stats/public-hit').set('cf-connecting-ip', '203.0.113.9').send({ name: 'page-view', page: '/' });
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await send().expect(204);
    }
    await send().expect(429);
    await request(app).post('/api/stats/public-hit').set('cf-connecting-ip', '203.0.113.10').send({ name: 'page-view', page: '/' }).expect(204);
  }, 60_000);

  it('limits signed-in events to 60 a minute per person across IPs', async () => {
    const user = await User.create({ username: 'limited', email: 'limited@example.test', password: 'pw-123456' });
    const token = issueSessionToken(user);
    const send = (n) => request(app).post('/api/stats/ui-event').set('cf-connecting-ip', `198.51.100.${n}`)
      .set('cf-ipcountry', 'US').set('Authorization', `Bearer ${token}`).send({ name: 'app-open', screen: '/' });
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await send(i % 3).expect(204);
    }
    await send(200).expect(429);
  }, 60_000);
});
