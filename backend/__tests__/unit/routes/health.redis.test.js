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

const { pool: mockPgPool } = require('../../../config/db-pg');
const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

// Real I/O is not faked: spin the event loop until a condition holds. It throws
// when the rounds run out, so a barrier that can never open fails loudly.
const until = async (condition, rounds = 5000) => {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('until: the condition never held');
};

class ClientClosedError extends Error {}

// A client that models @redis/client 1.6.1's socket.js: connect() sets isOpen;
// the socket is stored, and 'connect' emitted, only when createSocket resolves
// (the test releases it with `releaseSocket` when `holdSocket` is set);
// disconnect() throws ClientClosedError when !isOpen and otherwise destroys
// only a socket that is already stored. A disconnect during the 'connect' emit
// makes the initiator fail, as in the library.
const makeClient = ({
  ping = async () => 'PONG', connectError, holdSocket = false, initiatorHangs = false,
} = {}) => {
  const handlers = {};
  const c = {
    isOpen: false,
    socket: undefined,
    sockets: [],
    releaseSocket: undefined,
    on: jest.fn((event, fn) => { (handlers[event] = handlers[event] || []).push(fn); return c; }),
    connect: jest.fn(async () => {
      c.isOpen = true;
      if (connectError) {
        c.isOpen = false; // a failed connect with no retry closes the client
        throw connectError;
      }
      if (holdSocket) await new Promise((resolve) => { c.releaseSocket = resolve; });
      c.socket = { destroy: jest.fn() };
      c.sockets.push(c.socket);
      (handlers.connect || []).forEach((fn) => fn());
      if (!c.socket) throw new ClientClosedError('closed during connect');
      if (initiatorHangs) await new Promise(() => {});
    }),
    disconnect: jest.fn(() => {
      if (!c.isOpen) throw new ClientClosedError('The client is closed');
      c.isOpen = false;
      if (c.socket) {
        c.socket.destroy();
        c.socket = undefined;
      }
    }),
    ping: jest.fn(ping),
  };
  return c;
};

describe('GET /api/health redis check', () => {
  const ENV = ['AGENT_PROVISIONER_K8S', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REQUIRE_SHARED_REDIS', 'PG_HOST'];
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
    expect(mockClient.sockets[0].destroy).toHaveBeenCalledTimes(1); // a normal success closes its socket
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
    expect(res.body.checks.redis).toEqual({ status: 'unhealthy', error: 'unavailable' });
    expect(res.body.status).toBe('healthy');
    expect(res.status).toBe(200);
  });

  it('degrades the overall status on a Redis failure when REQUIRE_SHARED_REDIS=1', async () => {
    process.env.REDIS_HOST = 'cache.internal';
    process.env.REQUIRE_SHARED_REDIS = '1';
    mockClient = makeClient({ connectError: new Error('ECONNREFUSED') });
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

  // The mock above cannot model the client's own startup, which is what made a
  // synchronous late close reject unhandled. These run the real @redis/client
  // against a local server that accepts and never replies.
  describe('with the real client', () => {
    const net = require('net'); // eslint-disable-line global-require
    let server;
    let sockets;
    let unhandled;
    const onUnhandled = (reason) => { unhandled.push(reason); };
    const realClient = (extra = {}) => jest.requireActual('redis').createClient({
      url: `redis://127.0.0.1:${server.address().port}`,
      password: 'probe-test', // makes the client's startup queue AUTH and CLIENT SETINFO
      socket: { connectTimeout: 1000, reconnectStrategy: false },
      ...extra,
    });
    const serverSawClose = (index) => new Promise((resolve) => {
      const watch = setInterval(() => {
        if (sockets[index]) {
          clearInterval(watch);
          if (sockets[index].destroyed || sockets[index].readableEnded) resolve();
          else sockets[index].on('close', resolve);
        }
      }, 10);
    });
    const letRejectionsSurface = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    beforeEach(async () => {
      sockets = [];
      unhandled = [];
      process.on('unhandledRejection', onUnhandled);
      server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on('error', () => {});
        socket.resume(); // read, or the client's FIN is never seen
      });
      await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    });
    afterEach(async () => {
      process.off('unhandledRejection', onUnhandled);
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => { server.close(resolve); });
    });

    it('closes a late socket, as the probe attaches it, with no unhandled rejection', async () => {
      const client = realClient();
      client.on('error', () => undefined);
      const state = { finished: true, socketStored: false }; // the deadline already passed
      healthRoutes.closeOnLateSocket(client, state);
      client.connect().catch(() => undefined);
      await serverSawClose(0);
      await letRejectionsSurface();
      expect(state.socketStored).toBe(true);
      expect(unhandled).toEqual([]);
    }, 6000);

    it('a server that never replies sees its connection closed at the deadline, with no unhandled rejection', async () => {
      process.env.REDIS_HOST = '127.0.0.1';
      process.env.REDIS_PORT = String(server.address().port);
      process.env.REDIS_PASSWORD = 'probe-test';
      mockCreateClient.mockImplementationOnce((...args) => jest.requireActual('redis').createClient(...args));
      const closed = serverSawClose(0);
      const res = await request(buildApp()).get('/api/health');
      expect(res.body.checks.redis.status).toBe('unhealthy');
      await closed;
      await letRejectionsSurface();
      expect(unhandled).toEqual([]);
    }, 6000);
  });


  describe('bounded probes, on fake timers', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'performance'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    beforeEach(() => {
      unhandled.length = 0;
      process.on('unhandledRejection', onUnhandled);
    });
    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    const startProbe = async () => {
      const pending = request(buildApp()).get('/api/health').then((r) => r);
      await until(() => mockClient.connect.mock.calls.length > 0);
      return { pending };
    };

    it('bounds a PING that never answers, and destroys the socket at the deadline', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ ping: () => new Promise(() => {}) });
      const { pending } = await startProbe();
      await jest.advanceTimersByTimeAsync(1600);
      const res = await pending;
      expect(res.body.checks.redis.status).toBe('unhealthy');
      expect(res.body.checks.redis.error).toBe('timeout');
      expect(mockClient.sockets[0].destroy).toHaveBeenCalledTimes(1);
    });

    it('destroys the socket at the deadline when the initiator hangs after the socket is stored', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ initiatorHangs: true });
      const { pending } = await startProbe();
      await jest.advanceTimersByTimeAsync(1600);
      const res = await pending;
      expect(res.body.checks.redis.status).toBe('unhealthy');
      expect(mockClient.sockets).toHaveLength(1);
      expect(mockClient.sockets[0].destroy).toHaveBeenCalledTimes(1);
      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it('closes nothing while no socket exists, then destroys the late socket once it is stored', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ holdSocket: true });
      const { pending } = await startProbe();
      await jest.advanceTimersByTimeAsync(1600);
      const res = await pending;
      expect(res.body.checks.redis.status).toBe('unhealthy');
      // A disconnect() now would flip the client closed and strand the socket.
      expect(mockClient.disconnect).not.toHaveBeenCalled();
      expect(mockClient.isOpen).toBe(true);
      mockClient.releaseSocket();
      await until(() => mockClient.sockets.length === 1);
      await until(() => mockClient.sockets[0].destroy.mock.calls.length > 0);
      expect(mockClient.sockets[0].destroy).toHaveBeenCalledTimes(1);
      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    });

    it('a connect that fails with no socket closes nothing and rejects nothing unhandled', async () => {
      process.env.REDIS_HOST = 'cache.internal';
      mockClient = makeClient({ connectError: new Error('ECONNREFUSED') });
      const res = await (await startProbe()).pending;
      expect(res.body.checks.redis).toEqual({ status: 'unhealthy', error: 'connection_refused' });
      expect(mockClient.disconnect).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
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
      process.env.PG_HOST = 'pg.internal'; // the route queries PG only when this is set
      mockClient = makeClient({ ping: () => new Promise((resolve) => { release = () => resolve('PONG'); }) });
      const app = buildApp();
      const first = request(app).get('/api/health').then((r) => r);
      const second = request(app).get('/api/health').then((r) => r);
      // Each request runs its PG check right before it asks for the probe, in
      // the same microtask chain: once PG has been queried twice and a turn of
      // the loop has passed, both requests have called the probe.
      await until(() => mockPgPool.query.mock.calls.length >= 2);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockPgPool.query).toHaveBeenCalledTimes(2);
      expect(mockClient.ping).toHaveBeenCalledTimes(1);
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
