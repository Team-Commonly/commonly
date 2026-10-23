/**
 * The app's last error handler answers with the error's status and that
 * status's standard phrase, and logs only the status. Run on a real Express app
 * with NODE_ENV=development, the setting under which Express's built-in
 * handler includes the most detail.
 */
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const { finalErrorHandler } = require('../../../middleware/finalErrorHandler');

const build = () => {
  const app = express();
  app.use(cors({
    origin: (origin, callback) => (!origin || origin === 'https://allowed.example' ? callback(null, true) : callback(new Error('Not allowed by CORS'))),
  }));
  app.use(express.json({ limit: '64b' }));
  app.post('/echo', (req, res) => res.json({ ok: true }));
  app.get('/throws', () => { throw new Error('secret detail at /srv/app/internal.ts:12'); });
  app.get('/forbidden', (req, res, next) => next(Object.assign(new Error('owner check failed for x'), { status: 403 })));
  app.get('/not-found', (req, res, next) => next(Object.assign(new Error('no row 42'), { statusCode: 404 })));
  app.get('/odd-status', (req, res, next) => next(Object.assign(new Error('odd'), { status: 302 })));
  app.use(finalErrorHandler);
  return app;
};

// Anything a stack, a path or an error's own message would put in a body.
const leaks = (text) => /\bat\s|\/srv\/|node_modules|secret detail|owner check|no row 42|Unexpected token|Not allowed by CORS|entity/i.test(text);

describe('final error handler', () => {
  const saved = process.env.NODE_ENV;
  let app;
  beforeAll(() => {
    process.env.NODE_ENV = 'development';
    app = build();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(() => {
    process.env.NODE_ENV = saved;
    jest.restoreAllMocks();
  });

  test.each([
    ['a body that is not JSON', () => request(app).post('/echo').set('Content-Type', 'application/json').send('{"a":'), 400, 'Bad Request'],
    ['a body over the size limit', () => request(app).post('/echo').send({ a: 'x'.repeat(200) }), 413, 'Payload Too Large'],
    ['a disallowed origin', () => request(app).get('/throws').set('Origin', 'https://other.example'), 500, 'Internal Server Error'],
    ['an unhandled throw', () => request(app).get('/throws'), 500, 'Internal Server Error'],
    ['a 403 passed on', () => request(app).get('/forbidden'), 403, 'Forbidden'],
    ['a 404 passed on as statusCode', () => request(app).get('/not-found'), 404, 'Not Found'],
    ['a status outside 4xx/5xx', () => request(app).get('/odd-status'), 500, 'Internal Server Error'],
  ])('%s: keeps its status and answers only the phrase', async (_label, send, status, phrase) => {
    const res = await send();
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: phrase });
    expect(leaks(res.text)).toBe(false);
  });

  test('the log records status without exception or request detail', async () => {
    console.error.mockClear();
    console.warn.mockClear();
    await request(app).get('/throws');
    await request(app).get('/forbidden');
    expect(JSON.stringify(console.error.mock.calls)).toContain('500');
    expect(JSON.stringify(console.warn.mock.calls)).toContain('403');
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('secret detail');
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('owner check failed');
  });

  test('CONTROL: an allowed origin and a valid body still succeed', async () => {
    const res = await request(app).post('/echo').set('Origin', 'https://allowed.example').send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('after headers are sent it writes nothing and passes the error on to Express', () => {
    const err = new Error('after headers');
    const res = { headersSent: true, status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();
    finalErrorHandler(err, { method: 'GET', path: '/late' }, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('server.ts wiring', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../../server.ts'), 'utf8');

  test('registered after Sentry\'s handler, and no later top-level route', () => {
    const sentry = src.indexOf('attachSentryErrorHandler(app);');
    const handler = src.indexOf("app.use(require('./middleware/finalErrorHandler').finalErrorHandler);");
    expect(sentry).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(sentry);
    expect(src.slice(handler + 1)).not.toMatch(/^app\.(use|get|post|put|patch|delete)\(/m);
  });

  test('the late-mounted /api/pg/messages carries its own copy', () => {
    expect(src).toMatch(/app\.use\(\s*'\/api\/pg\/messages',\s*pgMessageRoutes,\s*require\('\.\/middleware\/finalErrorHandler'\)\.finalErrorHandler,\s*\)/);
  });
});
