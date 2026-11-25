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
      expect(res.body).toEqual({ message: 'rate limit exceeded: 60 machine requests per 60s' });
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
      expect(res.body).toEqual({ msg: 'rate limit exceeded: 120 binding ops per 60s' });
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
