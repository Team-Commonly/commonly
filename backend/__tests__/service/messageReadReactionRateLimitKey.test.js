/**
 * F456 — the message read limiter and the reaction limiter bucket a caller by
 * the credential auth actually reads, as the write limiter does since F141.
 *
 * Both used to key on the raw Authorization header only. A caller that sends
 * its token on `x-commonly-agent-token` (dualAuth, the reaction and thread
 * routes) or on `x-auth-token` (auth, the read route) with no Authorization
 * header fell to the IP key, which behind cloudflared is one bucket shared by
 * every such caller. Not a bypass: an over-throttle of callers behind one IP.
 *
 * The limiter runs before auth, so unknown tokens are enough to fill a bucket;
 * each refused request still counts. Own file so the in-memory stores are fresh.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/pg/Message');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const messageRoutes = require('../../routes/messages');

jest.setTimeout(120_000);

const app = express();
app.use(express.json());
app.use('/api/messages', messageRoutes);

const id = () => new mongoose.Types.ObjectId().toHexString();
// Route-level proof for the keys unit-tested in
// __tests__/unit/middleware/credentialRateLimitKey.test.js.

// Fill a bucket to its limit; every request up to it must get through the limiter.
const fill = async (n, send) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    expect((await send()).status).not.toBe(429);
  }
};

describe('reaction limiter keying (dualAuth routes)', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  const react = (headers) => {
    const req = request(app).post(`/api/messages/${id()}/reactions`).send({ emoji: '👍' });
    Object.entries(headers).forEach(([k, v]) => req.set(k, v));
    return req;
  };

  test('two agents on x-commonly-agent-token from one address get separate buckets', async () => {
    await fill(120, () => react({ 'x-commonly-agent-token': 'cm_agent_rxn_a' }));
    expect((await react({ 'x-commonly-agent-token': 'cm_agent_rxn_a' })).status).toBe(429);
    expect((await react({ 'x-commonly-agent-token': 'cm_agent_rxn_b' })).status).not.toBe(429);
  });

  test('the same agent token is one bucket whichever header carries it', async () => {
    await fill(120, () => react({ 'x-commonly-agent-token': 'cm_agent_rxn_c' }));
    expect((await react({ Authorization: 'Bearer cm_agent_rxn_c' })).status).toBe(429);
  });
});

describe('message read limiter keying (auth route)', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  const read = (headers) => {
    const req = request(app).get(`/api/messages/${id()}`);
    Object.entries(headers).forEach(([k, v]) => req.set(k, v));
    return req;
  };

  test('two people on x-auth-token from one address get separate buckets', async () => {
    await fill(240, () => read({ 'x-auth-token': 'human-read-token-a' }));
    expect((await read({ 'x-auth-token': 'human-read-token-a' })).status).toBe(429);
    expect((await read({ 'x-auth-token': 'human-read-token-b' })).status).not.toBe(429);
  });

  test('the same token is one bucket whichever header carries it', async () => {
    await fill(240, () => read({ 'x-auth-token': 'human-read-token-c' }));
    expect((await read({ Authorization: 'Bearer human-read-token-c' })).status).toBe(429);
  });

  // auth never reads x-commonly-agent-token, so rotating it must not open a new
  // bucket on this route (the F455 shape). Keyed on dualAuth's selector instead,
  // each request here would get a fresh bucket and the read limit would not hold.
  test('rotating an agent header auth ignores keeps one read bucket', async () => {
    let n = 0;
    const rotating = () => read({ 'x-auth-token': 'human-read-token-d', 'x-commonly-agent-token': `cm_agent_rot_${n += 1}` });
    await fill(240, rotating);
    expect((await rotating()).status).toBe(429);
  });
});
