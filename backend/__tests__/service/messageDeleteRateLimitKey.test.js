/**
 * F141 / TASK-773 — the message write limiter buckets an agent by its own
 * credential.
 *
 * `DELETE /api/messages/:id` now takes dualAuth, which accepts a runtime token
 * on `x-commonly-agent-token` with no Authorization header. The limiter used
 * to key on the Authorization header only, so every such caller fell to the
 * IP key — and behind cloudflared, one shared bucket for every agent. It now
 * keys on the credential dualAuth itself selects (`resolveDualAuthCredential`).
 *
 * The limiter runs before auth, so unknown tokens are enough to fill a bucket;
 * each refused request still counts. Own file so the in-memory store is fresh.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/pg/Message');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const messageRoutes = require('../../routes/messages');

jest.setTimeout(60_000);

const app = express();
app.use(express.json());
app.use('/api/messages', messageRoutes);

const id = () => new mongoose.Types.ObjectId().toHexString();

describe('message write limiter keying', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  test('two agents on x-commonly-agent-token from one address get separate buckets', async () => {
    const send = (token) => request(app).delete(`/api/messages/${id()}`).set('x-commonly-agent-token', token);
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await send('cm_agent_bucket_a')).status).not.toBe(429);
    }
    expect((await send('cm_agent_bucket_a')).status).toBe(429);
    expect((await send('cm_agent_bucket_b')).status).not.toBe(429);
  });

  test('the same agent token is one bucket whichever header carries it', async () => {
    const token = 'cm_agent_bucket_c';
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).delete(`/api/messages/${id()}`).set('x-commonly-agent-token', token);
      expect(res.status).not.toBe(429);
    }
    const viaBearer = await request(app).delete(`/api/messages/${id()}`).set('Authorization', `Bearer ${token}`);
    expect(viaBearer.status).toBe(429);
  });
});
