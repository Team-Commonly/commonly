// /api/health reports the Redis the backend actually uses (F608). The probe
// runs wherever the socket.io adapter connects (AGENT_PROVISIONER_K8S=1 or
// REDIS_HOST), and a failure flips the overall status only for a process that
// cannot run without shared Redis (REQUIRE_SHARED_REDIS=1) or on Kubernetes.

const request = require('supertest');
const express = require('express');

let mockClient;
const mockCreateClient = jest.fn(() => mockClient);
jest.mock('redis', () => ({ createClient: (...args) => mockCreateClient(...args) }));
jest.mock('../../../config/db-pg', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }), on: jest.fn() },
  connectPG: jest.fn(),
}));
jest.mock('mongoose', () => ({
  connection: { readyState: 1, db: { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) } },
}));

const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

// Real I/O is not faked: spin the event loop until a request has reached the probe.
const until = async (condition, rounds = 5000) => {
  for (let i = 0; i < rounds && !condition(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const makeClient = (overrides = {}) => ({
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  ping: jest.fn().mockResolvedValue('PONG'),
  disconnect: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('GET /api/health redis check', () => {
  const ENV = ['AGENT_PROVISIONER_K8S', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REQUIRE_SHARED_REDIS'];
  const saved = {};
  beforeEach(() => {
    jest.clearAllMocks();
    healthRoutes.resetRedisProbeForTests();
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    mockClient = makeClient();
  });
  afterEach(() => {
    ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  it('is not_configured when neither REDIS_HOST nor Kubernetes is set, and opens no client', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.redis.status).toBe('not_configured');
    expect(res.body.status).toBe('healthy');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('probes the REDIS_HOST the app connects to, off Kubernetes, and reports healthy', async () => {
    process.env.REDIS_HOST = 'cache.internal';
    process.env.REDIS_PORT = '6380';
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.redis.status).toBe('healthy');
    expect(res.status).toBe(200);
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ url: 'redis://cache.internal:6380' }));
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('still probes on Kubernetes without REDIS_HOST (the default host)', async () => {
    process.env.AGENT_PROVISIONER_K8S = '1';
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.redis.status).toBe('healthy');
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ url: 'redis://redis:6379' }));
  });

  it('reports a failed PING as unhealthy without degrading a process that falls back in-process', async () => {
    process.env.REDIS_HOST = 'cache.internal';
    mockClient = makeClient({ ping: jest.fn().mockRejectedValue(new Error('connection lost')) });
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.redis).toEqual({ status: 'unhealthy', error: 'connection lost' });
    expect(res.body.status).toBe('healthy');
    expect(res.status).toBe(200);
  });

  it('degrades the overall status on a Redis failure when REQUIRE_SHARED_REDIS=1', async () => {
    process.env.REDIS_HOST = 'cache.internal';
    process.env.REQUIRE_SHARED_REDIS = '1';
    mockClient = makeClient({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.redis.status).toBe('unhealthy');
    expect(res.body.status).toBe('degraded');
    expect(res.status).toBe(503);
  });

  it('keeps degrading on Kubernetes, as before', async () => {
    process.env.AGENT_PROVISIONER_K8S = '1';
    mockClient = makeClient({ ping: jest.fn().mockResolvedValue('NOPE') });
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.redis).toEqual({ status: 'unhealthy', error: 'Ping failed' });
    expect(res.body.status).toBe('degraded');
  });


  describe('bounded probes, on fake timers', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'performance'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('bounds a PING that never answers, and does not hang the endpoint', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ ping: jest.fn(() => new Promise(() => {})) });
      const pending = request(buildApp()).get('/api/health').then((r) => r);
      await until(() => mockCreateClient.mock.calls.length > 0 && mockClient.connect.mock.calls.length > 0);
      await jest.advanceTimersByTimeAsync(1600);
      const res = await pending;
      expect(res.body.checks.redis.status).toBe('unhealthy');
      expect(res.body.checks.redis.error).toMatch(/did not answer/);
      expect(mockClient.disconnect).toHaveBeenCalled();
    });

    it('bounds a connect that never settles, and closes the client', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ connect: jest.fn(() => new Promise(() => {})) });
      const pending = request(buildApp()).get('/api/health').then((r) => r);
      await until(() => mockCreateClient.mock.calls.length > 0 && mockClient.connect.mock.calls.length > 0);
      await jest.advanceTimersByTimeAsync(1600);
      const res = await pending;
      expect(res.body.checks.redis.status).toBe('unhealthy');
      expect(mockClient.disconnect).toHaveBeenCalled();
    });

    it('holds the race deadline past the socket connectTimeout, so the socket times out first', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ connect: jest.fn(() => new Promise(() => {})) });
      const pending = request(buildApp()).get('/api/health').then((r) => r);
      await until(() => mockClient.connect.mock.calls.length > 0);
      await jest.advanceTimersByTimeAsync(1100);
      // 1.1 s: past the socket's 1 s timeout, short of the 1.5 s deadline.
      expect(mockClient.disconnect).not.toHaveBeenCalled();
      expect(mockCreateClient.mock.calls[0][0].socket.connectTimeout).toBe(1000);
      await jest.advanceTimersByTimeAsync(500);
      await pending;
    });
  });

  describe('probe reuse', () => {
    let now;
    let nowSpy;
    beforeEach(() => {
      now = 1_000_000;
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      process.env.REDIS_HOST = 'cache.internal';
    });
    afterEach(() => nowSpy.mockRestore());

    it('shares one probe between concurrent calls', async () => {
      let release;
      mockClient = makeClient({ ping: jest.fn(() => new Promise((resolve) => { release = () => resolve('PONG'); })) });
      const app = buildApp();
      const first = request(app).get('/api/health').then((r) => r);
      const second = request(app).get('/api/health').then((r) => r);
      await until(() => mockClient.ping.mock.calls.length > 0);
      await until(() => false, 200); // let the second request reach the probe too
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.body.checks.redis.status).toBe('healthy');
      expect(b.body.checks.redis.status).toBe('healthy');
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it('reuses the result inside the window without a new connect', async () => {
      const app = buildApp();
      await request(app).get('/api/health');
      now += 4000;
      const res = await request(app).get('/api/health');
      expect(res.body.checks.redis.status).toBe('healthy');
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it('probes again after the window', async () => {
      const app = buildApp();
      await request(app).get('/api/health');
      now += 5001;
      await request(app).get('/api/health');
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });

    it('caches a failed probe for the same window, so an outage is not re-probed per request', async () => {
      process.env.REQUIRE_SHARED_REDIS = '1';
      mockClient = makeClient({ ping: jest.fn().mockRejectedValue(new Error('connection lost')) });
      const app = buildApp();
      await request(app).get('/api/health');
      now += 1000;
      const res = await request(app).get('/api/health');
      expect(res.body.checks.redis.status).toBe('unhealthy');
      expect(res.body.status).toBe('degraded'); // the degrade rule still applies to a cached failure
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
      now += 5000;
      await request(app).get('/api/health');
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });
  });
});
