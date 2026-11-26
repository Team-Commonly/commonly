// F631: when bindingRateLimit or machineRateLimit rejects a request, the server
// logs one line naming the client (once per key per minute), and the 429 status
// and body stay exactly what they were.
const request = require('supertest');
const express = require('express');

// Auth runs after the limiter on every route. Short-circuit it so only the
// limiter is under test and no database is needed.
jest.mock('../../../middleware/auth', () => {
  const mw = (_req, res) => res.status(204).end();
  mw.touchLastActive = jest.fn();
  return mw;
});
jest.mock('../../../middleware/daemonAuth', () => ({
  __esModule: true,
  default: () => (_req, res) => res.status(204).end(),
}));

const MACHINE_ID = '0123456789abcdef01234567';
const DUPLICATE_DAEMON_ERROR = "rate limit exceeded on this computer's daemon key: more than one Commonly daemon may be running. Update the CLI, then reinstall the daemon: npx @commonlyai/cli@latest daemon setup";
const DAEMON_TOKEN = `Bearer cm_daemon_${'e'.repeat(32)}`;

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/machines', require('../../../routes/machines'));
  app.use('/api/agent-binding', require('../../../routes/agentBinding'));
  return app;
};

const rateLimitLines = (spy) => spy.mock.calls.filter((c) => c[0] === '[rate-limit] rejected %j');

let warnSpy;
beforeEach(() => {
  jest.resetModules();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const hit = (app, method, url) => request(app)[method](url)
  .set('Authorization', DAEMON_TOKEN)
  .set('User-Agent', 'commonly-cli/1.4.2 (darwin; arm64)');

describe('machineRateLimit rejection log', () => {
  it('keeps its 429 body and logs one named line per key per minute', async () => {
    const app = buildApp();
    const url = `/api/machines/${MACHINE_ID}/heartbeat?k=querysecret`;
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await hit(app, 'post', url);
      expect(ok.status).toBe(204);
    }
    const rejected = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      rejected.push(await hit(app, 'post', url).send({ token: 'bodysecret' }));
    }
    for (const res of rejected) {
      expect(res.status).toBe(429);
      // F637: the heartbeat's 429 also carries `error`, which old daemons print first.
      expect(res.body).toEqual({ message: 'rate limit exceeded: 60 machine requests per 60s', error: DUPLICATE_DAEMON_ERROR });
    }
    const lines = rateLimitLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      limiter: 'machine',
      route: 'POST /api/machines/:id/heartbeat',
      keyKind: 'tok',
      machineDbId: MACHINE_ID,
      ua: 'commonly-cli/1.4.2',
      suppressed: 0,
    });
    expect(lines[0][1].keyPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(lines)).not.toMatch(/querysecret|bodysecret|cm_daemon|Bearer/);
  });
});

describe('bindingRateLimit rejection log', () => {
  it('keeps its 429 body and logs one named line per key per minute', async () => {
    const app = buildApp();
    for (let i = 0; i < 120; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await hit(app, 'get', '/api/agent-binding/assigned');
      expect(ok.status).toBe(204);
    }
    const rejected = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      rejected.push(await hit(app, 'get', '/api/agent-binding/assigned'));
    }
    for (const res of rejected) {
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ msg: 'rate limit exceeded: 120 binding ops per 60s', error: DUPLICATE_DAEMON_ERROR });
    }
    const lines = rateLimitLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      limiter: 'binding',
      route: 'GET /api/agent-binding/assigned',
      keyKind: 'tok',
      ua: 'commonly-cli/1.4.2',
      suppressed: 0,
    });
    expect(lines[0][1]).not.toHaveProperty('machineDbId');
  });
});

// F637: a Windows install piled up ~140 daemons on one key. Old CLIs print the
// 429's `error` field first, so the two daemon routes say what is wrong and how
// to fix it; the other routes under the same limiters keep their bodies.
describe('F637: the duplicate-daemon hint on the two daemon routes', () => {
  const tokenHit = (app, method, url, token) => request(app)[method](url).set('Authorization', token);
  const exhaust = async (app, method, url, token, n) => {
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tokenHit(app, method, url, token);
    }
    return tokenHit(app, method, url, token);
  };

  it('the heartbeat 429 carries error and Retry-After; GET /me under the same limiter carries no error', async () => {
    const app = buildApp();
    const hb = await exhaust(app, 'post', `/api/machines/${MACHINE_ID}/heartbeat`, `Bearer cm_daemon_${'a'.repeat(32)}`, 60);
    expect(hb.status).toBe(429);
    expect(hb.body.error).toBe(DUPLICATE_DAEMON_ERROR);
    expect(hb.body.message).toBe('rate limit exceeded: 60 machine requests per 60s');
    expect(Number(hb.headers['retry-after'])).toBeGreaterThan(0);
    const me = await exhaust(app, 'get', '/api/machines/me', `Bearer cm_daemon_${'b'.repeat(32)}`, 60);
    expect(me.status).toBe(429);
    expect(me.body).toEqual({ message: 'rate limit exceeded: 60 machine requests per 60s' });
  });

  it('GET /assigned carries error; POST /adopt under the same limiter carries none', async () => {
    const app = buildApp();
    const assigned = await exhaust(app, 'get', '/api/agent-binding/assigned', `Bearer cm_daemon_${'c'.repeat(32)}`, 120);
    expect(assigned.status).toBe(429);
    expect(assigned.body.error).toBe(DUPLICATE_DAEMON_ERROR);
    expect(assigned.body.msg).toBe('rate limit exceeded: 120 binding ops per 60s');
    expect(Number(assigned.headers['retry-after'])).toBeGreaterThan(0);
    const adopt = await exhaust(app, 'post', '/api/agent-binding/adopt', `Bearer cm_daemon_${'d'.repeat(32)}`, 120);
    expect(adopt.status).toBe(429);
    expect(adopt.body).toEqual({ msg: 'rate limit exceeded: 120 binding ops per 60s' });
  });
});
