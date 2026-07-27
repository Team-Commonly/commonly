// Regression: analytics must not count bot User rows as humans.
//
// The original HUMAN_FILTER keyed only on `botMetadata.agentName` absence,
// using an $or that ALSO passed anything without a botMetadata object. Bot
// rows written by the gateway bridge / summarizer / several openclaw install
// paths carry botMetadata WITHOUT an agentName key, so they satisfied the
// second clause and were counted as humans. On the dev instance that was 8
// rows out of 85 — totalUsers/DAU/WAU inflated ~10%, and every funnel rate
// deflated, because a bot sitting in the denominator can never convert.
//
// These run against a real in-memory Mongo so the FILTER SEMANTICS are what's
// under test, not a mock's recorded call args.

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'admin1' };
  req.userId = 'admin1';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: () => 'test-key',
}));

// No PostgreSQL in this tier — the message-sourced columns are covered by
// admin.analytics.funnel.test.js.
const mockPgQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../../config/db-pg', () => ({
  pool: { query: (...args) => mockPgQuery(...args) },
}));

const User = require('../../../models/User');
const routes = require('../../../routes/admin/analytics');

const DAY = 24 * 60 * 60 * 1000;
const recently = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

let mongod;
let app;

const seed = (over) => ({
  username: over.username,
  email: `${over.username}@example.test`,
  password: 'x',
  createdAt: new Date(Date.now() - DAY),
  lastActive: recently(),
  ...over,
});

describe('admin analytics — bot rows must never be counted as humans', () => {
  beforeAll(async () => {
    // eslint-disable-next-line global-require
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    await User.create([
      // The only real human.
      seed({ username: 'real-human' }),

      // Classic agent row — already excluded before this fix.
      seed({
        username: 'openclaw-theo',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId: 'theo' },
      }),

      // THE LEAK: botMetadata present, no agentName key. Passed the old
      // $or filter as a human. Mirrors clawdbot-bridge / commonly-summarizer
      // / openclaw-inst-* / socialpulse-* on the live instance.
      seed({
        username: 'clawdbot-bridge',
        isBot: true,
        botMetadata: { displayName: 'clawdbot-bridge', capabilities: [] },
      }),

      // Same leak shape, no botMetadata at all — only isBot marks it.
      seed({ username: 'bare-bot', isBot: true }),
    ]);
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(() => {
    app = express();
    app.use('/api/admin/analytics', routes);
  });

  it('counts one human out of four rows, not three', async () => {
    const res = await request(app).get('/api/admin/analytics/usage?days=30');
    expect(res.status).toBe(200);
    expect(res.body.totals.totalUsers).toBe(1);
  });

  it('excludes bots from DAU and WAU even though all four are freshly active', async () => {
    const res = await request(app).get('/api/admin/analytics/usage?days=30');
    expect(res.status).toBe(200);
    expect(res.body.totals.dau).toBe(1);
    expect(res.body.totals.wau).toBe(1);
  });

  it('excludes bots from signup cohorts, so the funnel denominator is human-only', async () => {
    const res = await request(app).get('/api/admin/analytics/funnel?days=30');
    expect(res.status).toBe(200);
    expect(res.body.totals.signups).toBe(1);
  });

  it('treats HUMAN_FILTER and BOT_FILTER as exact complements', async () => {
    // Every row is classified exactly once. If these two ever drift apart, a
    // row is either counted twice or dropped from both — and the "distinct
    // human posters" metric silently double-subtracts.
    const usage = await request(app).get('/api/admin/analytics/usage?days=30');
    expect(usage.status).toBe(200);

    const humans = usage.body.totals.totalUsers;
    const bots = await User.countDocuments({
      $or: [{ isBot: true }, { 'botMetadata.agentName': { $exists: true } }],
    });
    expect(humans + bots).toBe(await User.countDocuments({}));
  });
});
