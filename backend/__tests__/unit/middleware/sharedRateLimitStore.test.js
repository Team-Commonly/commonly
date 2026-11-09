/**
 * The sign-in and sign-up limiters count in Redis, so a budget holds across
 * backend replicas instead of multiplying by their number. Redis is faked here
 * with the same two scripts' semantics; the property under test is that two
 * replicas sharing it refuse at the stated budget, and that a Redis that is
 * down or hung never turns sign-in off.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { rateLimit } = require('express-rate-limit');
const {
  COMMAND_TIMEOUT_MS, DECREMENT_SCRIPT, INCREMENT_SCRIPT, SharedRateLimitStore,
} = require('../../../middleware/sharedRateLimitStore');

const fakeRedis = () => {
  const counts = new Map();
  const expiries = new Map();
  const live = (key) => {
    if (expiries.has(key) && expiries.get(key) <= Date.now()) {
      counts.delete(key);
      expiries.delete(key);
    }
    return counts.has(key);
  };
  return {
    isReady: true,
    keysSeen: [],
    counts,
    async eval(script, { keys: [key], arguments: args }) {
      this.keysSeen.push(key);
      if (script === INCREMENT_SCRIPT) {
        const hits = (live(key) ? counts.get(key) : 0) + 1;
        counts.set(key, hits);
        if (!expiries.has(key)) expiries.set(key, Date.now() + Number(args[0]));
        return [hits, expiries.get(key) - Date.now()];
      }
      if (script === DECREMENT_SCRIPT) {
        if (live(key) && counts.get(key) > 0) counts.set(key, counts.get(key) - 1);
        return live(key) ? counts.get(key) : 0;
      }
      throw new Error('unknown script');
    },
    async del(key) {
      counts.delete(key);
      expiries.delete(key);
    },
  };
};

// One "replica": its own limiter and its own store instance, as each backend
// pod builds at require time, sharing only the Redis client.
const replica = (client, { max = 3, skipSuccessfulRequests = false } = {}) => {
  const app = express();
  app.use(express.json());
  app.post('/login', rateLimit({
    store: new SharedRateLimitStore({ name: 'test-login', getClient: () => client }),
    windowMs: 15 * 60 * 1000,
    limit: max,
    skipSuccessfulRequests,
    keyGenerator: (req) => `login-account:${req.body.email}`,
    validate: false,
  }), (req, res) => res.status(req.body.ok ? 200 : 401).json({}));
  return app;
};

describe('the shared rate-limit store', () => {
  let errorSpy;
  let logSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('two replicas sharing Redis refuse at the stated budget, not twice it', async () => {
    const client = fakeRedis();
    const [a, b] = [replica(client), replica(client)];
    const codes = [];
    for (const app of [a, b, a, b, a]) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await request(app).post('/login').send({ email: 'x@example.com' })).status);
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  test('control: with per-replica memory stores the same calls get twice the budget', async () => {
    const [a, b] = [replica(null), replica(null)];
    const codes = [];
    for (const app of [a, b, a, b, a, b, a]) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await request(app).post('/login').send({ email: 'x@example.com' })).status);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 401, 429]);
  });

  test('a successful request is taken back off the shared count', async () => {
    const client = fakeRedis();
    const [a, b] = [replica(client, { skipSuccessfulRequests: true }), replica(client, { skipSuccessfulRequests: true })];
    for (const app of [a, b, a, b, a]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).post('/login').send({ email: 'y@example.com', ok: true })).status).toBe(200);
    }
    expect([...client.counts.values()]).toEqual([0]);
  });

  test('keys reach Redis hashed, never with the submitted address in them', async () => {
    const client = fakeRedis();
    await request(replica(client)).post('/login').send({ email: 'private@example.com' });
    expect(client.keysSeen).toHaveLength(1);
    expect(client.keysSeen[0]).toMatch(/^rl:test-login:[0-9a-f]{64}$/);
    expect(client.keysSeen.join('')).not.toContain('private');
  });

  test('a Redis that is not connected yet falls back to counting per replica, without an error line', async () => {
    const client = { ...fakeRedis(), isReady: false };
    const app = replica(client);
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await request(app).post('/login').send({ email: 'z@example.com' })).status);
    }
    expect(codes).toEqual([401, 401, 401, 429]);
    // A pod that is still connecting is not an outage; the connection's own
    // errors are logged by the client, not by each limiter.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('a Redis that errors falls back, and the request is still answered', async () => {
    const client = { ...fakeRedis(), eval: async () => { throw new Error('READONLY'); } };
    const app = replica(client);
    expect((await request(app).post('/login').send({ email: 'e@example.com' })).status).toBe(401);
    expect((await request(app).post('/login').send({ email: 'e@example.com' })).status).toBe(401);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/counting per replica/);
  });

  test('a Redis that hangs costs a request the timeout, not the request', async () => {
    const client = { ...fakeRedis(), eval: () => new Promise(() => {}) };
    const started = Date.now();
    expect((await request(replica(client)).post('/login').send({ email: 'h@example.com' })).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(COMMAND_TIMEOUT_MS + 1500);
  });

  test('it says when it is counting in Redis, once', async () => {
    const app = replica(fakeRedis());
    await request(app).post('/login').send({ email: 'r@example.com' });
    await request(app).post('/login').send({ email: 'r@example.com' });
    const lines = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[rate-limit]'));
    expect(lines).toEqual(['[rate-limit] rl:test-login: is counting in Redis']);
  });
});

describe('the auth routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../routes/auth.ts'), 'utf8');

  test('every limiter counts in the shared store, each under its own name', () => {
    const limiters = source.split('= rateLimit({').slice(1);
    expect(limiters.length).toBeGreaterThan(0);
    const names = limiters.map((block) => /^\s*store: new SharedRateLimitStore\(\{ name: '([a-z-]+)' \}\),/.exec(block)?.[1]);
    expect(names).not.toContain(undefined);
    expect(new Set(names).size).toBe(names.length);
  });
});
