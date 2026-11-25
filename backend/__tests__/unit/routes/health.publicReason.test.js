// F624: /api/health, unauthenticated, must not echo a driver's error text. A
// driver message can name an internal host, IP:port, database or user; the
// response carries one of five fixed reasons and the full text goes to the log.

const request = require('supertest');
const express = require('express');

const mockMongo = {
  connection: { readyState: 1, db: { admin: () => ({ ping: jest.fn() }) } },
};
let mockRedisClient;
jest.mock('redis', () => ({ createClient: () => mockRedisClient }));
jest.mock('../../../config/db-pg', () => ({
  pool: { query: jest.fn(), on: jest.fn(), connect: jest.fn() },
  connectPG: jest.fn(),
}));
jest.mock('mongoose', () => mockMongo);
jest.mock('../../../services/agentEventService', () => ({ isInProcessDraining: () => false }));
jest.mock('../../../services/pgBootService', () => ({ pgRoutesAreMounted: () => true }));

const { pool: mockPgPool } = require('../../../config/db-pg');
const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

const LEAKS = ['10.0.0.5', '6379', '27017', '5432', 'db.internal.example', 'svc_health_user', 'prod_db'];
const expectNoLeak = (body) => {
  const text = JSON.stringify(body);
  LEAKS.forEach((needle) => expect(text).not.toContain(needle));
};

const withCode = (message, code, name) => Object.assign(new Error(message), { code }, name ? { name } : {});

const makeRedis = (connectError) => ({
  on: jest.fn(),
  isOpen: false,
  connect: jest.fn(async () => { throw connectError; }),
  disconnect: jest.fn(),
  ping: jest.fn(),
});

describe('health public reasons (F624)', () => {
  const ENV = ['AGENT_PROVISIONER_K8S', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REQUIRE_SHARED_REDIS', 'PG_HOST'];
  const saved = {};
  let warn;
  beforeEach(() => {
    healthRoutes.resetRedisProbeForTests();
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    mockMongo.connection.readyState = 1;
    mockMongo.connection.db = { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) };
    mockPgPool.query.mockReset().mockResolvedValue({ rows: [{ ok: 1 }] });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  describe('mapping', () => {
    const reason = (e) => healthRoutes.publicHealthReason(e);
    it('ECONNREFUSED gives connection_refused', () => {
      expect(reason(withCode('connect ECONNREFUSED 10.0.0.5:6379', 'ECONNREFUSED'))).toBe('connection_refused');
      expect(reason(new Error('connect ECONNREFUSED 10.0.0.5:27017'))).toBe('connection_refused');
    });
    it('ENOTFOUND and EAI_AGAIN give host_not_found', () => {
      expect(reason(withCode('getaddrinfo ENOTFOUND db.internal.example', 'ENOTFOUND'))).toBe('host_not_found');
      expect(reason(withCode('getaddrinfo EAI_AGAIN db.internal.example', 'EAI_AGAIN'))).toBe('host_not_found');
    });
    it('ETIMEDOUT and our own deadlines give timeout', () => {
      expect(reason(withCode('connect ETIMEDOUT 10.0.0.5:5432', 'ETIMEDOUT'))).toBe('timeout');
      expect(reason(new Error('Redis did not answer within 1500ms'))).toBe('timeout');
      expect(reason(new Error('did not answer within 1500ms'))).toBe('timeout');
      expect(reason(new Error('Server selection timed out after 30000 ms'))).toBe('timeout');
    });
    it('auth failures give auth_failed', () => {
      expect(reason(withCode('password authentication failed for user "svc_health_user"', '28P01'))).toBe('auth_failed');
      expect(reason(new Error('WRONGPASS invalid username-password pair'))).toBe('auth_failed');
      expect(reason(new Error('NOAUTH Authentication required.'))).toBe('auth_failed');
      expect(reason(withCode('Authentication failed.', 18, 'MongoServerError'))).toBe('auth_failed');
    });
    it('anything else gives unavailable', () => {
      expect(reason(new Error('something odd at 10.0.0.5'))).toBe('unavailable');
      expect(reason(undefined)).toBe('unavailable');
      expect(reason('boom')).toBe('unavailable');
    });
  });

  describe('responses carry no driver text', () => {
    it('mongodb', async () => {
      mockMongo.connection.db = {
        admin: () => ({ ping: jest.fn().mockRejectedValue(withCode('connect ECONNREFUSED 10.0.0.5:27017', 'ECONNREFUSED')) }),
      };
      const res = await request(buildApp()).get('/api/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks.mongodb).toEqual({ status: 'unhealthy', error: 'connection_refused' });
      expectNoLeak(res.body);
    });

    it('postgresql', async () => {
      process.env.PG_HOST = 'db.internal.example';
      mockPgPool.query.mockRejectedValue(
        withCode('password authentication failed for user "svc_health_user" database "prod_db" at 10.0.0.5:5432', '28P01'),
      );
      const res = await request(buildApp()).get('/api/health');
      expect(res.status).toBe(503);
      expect(res.body.checks.postgresql).toEqual({ status: 'unhealthy', error: 'auth_failed' });
      expectNoLeak(res.body);
    });

    it('redis', async () => {
      process.env.REDIS_HOST = 'db.internal.example';
      mockRedisClient = makeRedis(withCode('getaddrinfo ENOTFOUND db.internal.example:6379 (10.0.0.5)', 'ENOTFOUND'));
      const res = await request(buildApp()).get('/api/health');
      expect(res.body.checks.redis).toEqual({ status: 'unhealthy', error: 'host_not_found' });
      expectNoLeak(res.body);
    });

    it('redis keeps our own deadline as timeout', async () => {
      process.env.REDIS_HOST = 'cache';
      mockRedisClient = makeRedis(new Error('Redis did not answer within 1500ms'));
      const res = await request(buildApp()).get('/api/health');
      expect(res.body.checks.redis.error).toBe('timeout');
    });

    it('/ready not_ready body', async () => {
      Object.defineProperty(mockMongo.connection, 'readyState', {
        configurable: true,
        get() { throw withCode('connect ECONNREFUSED 10.0.0.5:27017 db prod_db user svc_health_user', 'ECONNREFUSED'); },
      });
      try {
        const res = await request(buildApp()).get('/api/health/ready');
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: 'not_ready', error: 'connection_refused' });
        expectNoLeak(res.body);
      } finally {
        Object.defineProperty(mockMongo.connection, 'readyState', { configurable: true, writable: true, value: 1 });
      }
    });
  });

  describe('logging', () => {
    const failMongo = (err) => {
      mockMongo.connection.db = { admin: () => ({ ping: jest.fn().mockRejectedValue(err) }) };
    };
    const healthWarns = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('health: mongodb'));

    it('logs the full message once for repeated identical failures, and again when the reason changes', async () => {
      failMongo(withCode('connect ECONNREFUSED 10.0.0.5:27017', 'ECONNREFUSED'));
      await request(buildApp()).get('/api/health');
      await request(buildApp()).get('/api/health');
      await request(buildApp()).get('/api/health');
      expect(healthWarns()).toHaveLength(1);
      expect(String(healthWarns()[0][0])).toContain('connection_refused');
      expect(String(healthWarns()[0][1])).toContain('10.0.0.5:27017');

      failMongo(withCode('getaddrinfo ENOTFOUND db.internal.example', 'ENOTFOUND'));
      await request(buildApp()).get('/api/health');
      await request(buildApp()).get('/api/health');
      expect(healthWarns()).toHaveLength(2);
      expect(String(healthWarns()[1][0])).toContain('host_not_found');
    });

    it('logs again when a failure recurs after a success', async () => {
      const err = withCode('connect ECONNREFUSED 10.0.0.5:27017', 'ECONNREFUSED');
      failMongo(err);
      await request(buildApp()).get('/api/health');
      mockMongo.connection.db = { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) };
      await request(buildApp()).get('/api/health');
      failMongo(err);
      await request(buildApp()).get('/api/health');
      expect(healthWarns()).toHaveLength(2);
    });

    it.each([
      ['bad uri mongodb://admin:s3cr3t@10.0.0.5:27017/prod_db', 's3cr3t'],
      ['postgres://u:p4ss/x@h:5432/db refused', 'p4ss'],
      ['connect failed u:p4ss@h:5432', 'p4ss'],
      ['redis://:p4ss@h:6379 refused', 'p4ss'],
      ['(u:p4ss/x@h:5432)', 'p4ss'],
    ])('never logs credentials: %s', async (message, secret) => {
      failMongo(new Error(message));
      await request(buildApp()).get('/api/health');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(secret);
      expect(logged).toContain('***@');
    });

    it('leaves an email-like a@b and ordinary text alone', async () => {
      failMongo(new Error('Error: contact ops@example.com, host 10.0.0.5:27017 down'));
      await request(buildApp()).get('/api/health');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('ops@example.com');
      expect(logged).not.toContain('***@');
    });

    it('/ready logs a second failure with the same reason after a recovery', async () => {
      const readyWarns = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('health: ready'));
      const breakMongo = () => Object.defineProperty(mockMongo.connection, 'readyState', {
        configurable: true,
        get() { throw withCode('connect ECONNREFUSED 10.0.0.5:27017', 'ECONNREFUSED'); },
      });
      const fixMongo = () => Object.defineProperty(mockMongo.connection, 'readyState', { configurable: true, writable: true, value: 1 });
      try {
        breakMongo();
        await request(buildApp()).get('/api/health/ready');
        await request(buildApp()).get('/api/health/ready');
        expect(readyWarns()).toHaveLength(1);
        fixMongo();
        await request(buildApp()).get('/api/health/ready').expect(200);
        breakMongo();
        await request(buildApp()).get('/api/health/ready');
        expect(readyWarns()).toHaveLength(2);
      } finally {
        fixMongo();
      }
    });

    describe('/ready postgres probe', () => {
      const pgWarns = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('health: postgresql-ready'));
      const { EventEmitter } = require('events');
      const poolWith = (query) => mockPgPool.connect.mockImplementation(async () => (
        Object.assign(new EventEmitter(), { query, release: jest.fn() })
      ));
      beforeEach(() => { process.env.PG_HOST = 'db.internal.example'; });

      it('logs a failing probe once, scrubbed, with no error field in the body', async () => {
        poolWith(async () => { throw withCode('connect ECONNREFUSED 10.0.0.5:5432 postgres://u:p4ss@h/db', 'ECONNREFUSED'); });
        const bodies = [];
        for (let i = 0; i < 3; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          bodies.push((await request(buildApp()).get('/api/health/ready').expect(200)).body);
        }
        bodies.forEach((b) => {
          expect(b.degraded).toEqual(['postgresql']);
          expect(b).not.toHaveProperty('error');
          expectNoLeak(b);
        });
        expect(pgWarns()).toHaveLength(1);
        expect(String(pgWarns()[0][0])).toContain('connection_refused');
        expect(JSON.stringify(pgWarns())).not.toContain('p4ss');
      });

      it('clears on recovery and logs a recurrence', async () => {
        const fail = async () => { throw withCode('connect ECONNREFUSED 10.0.0.5:5432', 'ECONNREFUSED'); };
        poolWith(fail);
        await request(buildApp()).get('/api/health/ready').expect(200);
        poolWith(async () => ({ rows: [{ ok: 1 }] }));
        const ok = await request(buildApp()).get('/api/health/ready').expect(200);
        expect(ok.body.degraded).toBeUndefined();
        poolWith(fail);
        await request(buildApp()).get('/api/health/ready').expect(200);
        expect(pgWarns()).toHaveLength(2);
      });
    });
  });
});
