/* eslint-disable global-require */
// F325. A real express app, the real Sentry SDK and the real `beforeSend`; only
// the transport is fake, so what is asserted is the envelope that would leave.
const fs = require('fs');
const path = require('path');
const express = require('express');
// As server.ts: a rejected async handler reaches the error middleware.
require('express-async-errors');
const request = require('supertest');

const mockEnvelopes = [];
const mockRawEvents = [];
const mockInitOptions = [];

jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return {
    ...actual,
    init: (options) => {
      mockInitOptions.push(options);
      return actual.init({
      ...options,
      transport: () => ({
        send: async (envelope) => { mockEnvelopes.push(envelope); return {}; },
        flush: async () => true,
      }),
      beforeSend: (event, hint) => {
        // A copy of what the SDK built, before the strip, so a test can show
        // the strip had something to remove.
        mockRawEvents.push(JSON.parse(JSON.stringify(event)));
        return options.beforeSend(event, hint);
      },
      });
    },
  };
});

const Sentry = require('@sentry/node');

const TOKEN = 'vendor_token_9f8E7d6C5b4A3f2E1d0C9b8A';
const NOON = Date.UTC(2026, 10, 7, 12);
const MINUTE = 60 * 1000;

const eventsSent = () => mockEnvelopes.flatMap((envelope) => envelope[1])
  .filter(([header]) => header.type === 'event')
  .map(([, body]) => body);

// `finish` fires as the response goes out; the SDK's pipeline is promise-based.
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  await Sentry.flush(500);
};

describe('serverErrorReport', () => {
  const report = require('../../../services/serverErrorReport');
  const { finalErrorHandler } = require('../../../middleware/finalErrorHandler');

  const appWith = (mount) => {
    const { attachSentryErrorHandler } = require('../../../instrument');
    const app = express();
    app.use(report.serverErrorReport);
    mount(app);
    attachSentryErrorHandler(app);
    app.use(finalErrorHandler);
    return app;
  };

  const podsApp = () => appWith((app) => {
    const router = express.Router();
    router.get('/:id/focus', (_req, res) => { res.status(500).json({ error: 'Server Error' }); });
    router.post('/:id/focus', (_req, res) => { res.status(503).json({ error: 'Unavailable' }); });
    router.get('/:id/gone', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
    router.get('/:id/throws', () => { throw new Error(`upstream said ${TOKEN}`); });
    router.get('/:id/async', async () => { throw new Error(`upstream said ${TOKEN}`); });
    router.get('/:id/next', (_req, _res, next) => { next(new Error(`upstream said ${TOKEN}`)); });
    app.use('/api/pods', router);
    const health = express.Router();
    health.get('/', (_req, res) => { res.status(503).json({ status: 'down' }); });
    health.get('/ready', (_req, res) => { res.status(503).json({ status: 'down' }); });
    app.use('/api/health', health);
    app.get('/api/healthcare', (_req, res) => { res.status(500).json({}); });
  });

  beforeEach(() => {
    mockEnvelopes.length = 0;
    mockRawEvents.length = 0;
    jest.spyOn(Date, 'now').mockReturnValue(NOON);
  });

  describe('with no DSN', () => {
    it('sends nothing and does not count, and the response is untouched', async () => {
      delete process.env.SENTRY_DSN;
      const capture = jest.spyOn(Sentry, 'captureEvent');
      const app = express();
      app.use(report.serverErrorReport);
      app.get('/api/x', (_req, res) => { res.status(500).json({}); });

      await request(app).get('/api/x').expect(500);
      await settle();

      expect(capture).not.toHaveBeenCalled();
      expect(eventsSent()).toEqual([]);
      expect(report.reportStateForTest()).toEqual({ fingerprints: 0, sentToday: 0 });
    });
  });

  describe('with a client', () => {
    beforeAll(() => {
      // Module load is what calls Sentry.init, so this first require is the init.
      process.env.SENTRY_DSN = 'https://public@sentry.invalid/1';
      require('../../../instrument');
    });

    afterAll(async () => {
      delete process.env.SENTRY_DSN;
      await Sentry.close(100);
    });

    beforeEach(() => {
      report.resetReportStateForTest();
    });

    describe('what is reported', () => {
      it('reports a 500 once, with the route pattern and no data', async () => {
        await request(podsApp())
          .get(`/api/pods/65f0a1b2c3d4e5f6a7b8c9d0/focus?code=${TOKEN}`)
          .set('Authorization', `Bearer ${TOKEN}`)
          .set('Cookie', `session=${TOKEN}`)
          .expect(500);
        await settle();

        const events = eventsSent();
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(expect.objectContaining({
          level: 'error',
          message: '5xx 500 GET /api/pods/:id/focus',
          fingerprint: ['5xx', 'GET', '/api/pods/:id/focus', '500'],
          tags: { source: 'handled_5xx', method: 'GET', route: '/api/pods/:id/focus', status: '500' },
        }));
        // The title exists only once `beforeSend` writes it from the issued record.
        expect(mockRawEvents[0].message).toBeUndefined();
        const wire = JSON.stringify(mockEnvelopes);
        expect(wire).not.toContain(TOKEN);
        expect(wire).not.toContain('65f0a1b2c3d4e5f6a7b8c9d0');
        expect(events[0].request).toBeUndefined();
        expect(events[0].user).toBeUndefined();
        expect(events[0].exception).toBeUndefined();
      });

      it('one report per fingerprint per 15 minutes, and the next window sends again', async () => {
        const app = podsApp();
        await request(app).get('/api/pods/one/focus').expect(500);
        await request(app).get('/api/pods/two/focus').expect(500);
        Date.now.mockReturnValue(NOON + 14 * MINUTE);
        await request(app).get('/api/pods/three/focus').expect(500);
        await settle();
        expect(eventsSent()).toHaveLength(1);

        Date.now.mockReturnValue(NOON + 15 * MINUTE);
        await request(app).get('/api/pods/four/focus').expect(500);
        await settle();
        expect(eventsSent()).toHaveLength(2);
      });

      it('a different method or status is a different fingerprint', async () => {
        const app = podsApp();
        await request(app).get('/api/pods/a/focus').expect(500);
        await request(app).post('/api/pods/a/focus').expect(503);
        await settle();
        expect(eventsSent().map((event) => event.message).sort()).toEqual([
          '5xx 500 GET /api/pods/:id/focus',
          '5xx 503 POST /api/pods/:id/focus',
        ]);
      });

      it('does not report a 404', async () => {
        await request(podsApp()).get('/api/pods/a/gone').expect(404);
        await settle();
        expect(eventsSent()).toEqual([]);
      });

      it('skips health endpoints, and only those', async () => {
        const app = podsApp();
        await request(app).get('/api/health').expect(503);
        await request(app).get('/api/health/ready').expect(503);
        // Express routes without case, so this reaches the same handler.
        await request(app).get('/API/Health/ready').expect(503);
        await settle();
        expect(eventsSent()).toEqual([]);

        await request(app).get('/api/healthcare').expect(500);
        await settle();
        expect(eventsSent()).toHaveLength(1);
      });

      it.each(['throws', 'async', 'next'])('an error through the error handler (%s) is one event, not two', async (how) => {
        await request(podsApp()).get(`/api/pods/a/${how}`).expect(500);
        await settle();

        const events = eventsSent();
        expect(events).toHaveLength(1);
        expect(events[0].exception.values[0].value).toBe('Unhandled request error');
        expect(events[0].message).toBeUndefined();
        expect(JSON.stringify(mockEnvelopes)).not.toContain(TOKEN);
      });

      it('a route mounted under a param does not leak its value', async () => {
        const app = appWith((a) => {
          const router = express.Router({ mergeParams: true });
          router.get('/items', (_req, res) => { res.status(500).json({}); });
          a.use('/api/grants/:grantId', router);
        });
        const cases = [
          ['65f0a1b2c3d4e5f6a7b8c9d0', '/api/grants/:value/items'],
          ['0f8fad5b-d9cb-469f-a165-70867728950e', '/api/grants/:value/items'],
          [TOKEN, '/api/grants/:value/items'],
          ['xk_live_supersecret', '/api/grants/:value/items'],
          [`:${'k'.repeat(12)}`, '/api/grants/:value/items'],
          ['Mixed%20Case', '/api/grants/:value/items'],
        ];
        for (const [value, route] of cases) {
          report.resetReportStateForTest();
          mockEnvelopes.length = 0;
          // eslint-disable-next-line no-await-in-loop
          await request(app).get(`/api/grants/${value}/items`).expect(500);
          // eslint-disable-next-line no-await-in-loop
          await settle();
          const events = eventsSent();
          expect(events).toHaveLength(1);
          expect(events[0].tags.route).toBe(route);
          expect(JSON.stringify(mockEnvelopes)).not.toContain(value);
        }
      });

      it('hex-shaped and word-shaped values under one param mount are one report', async () => {
        const app = appWith((a) => {
          const router = express.Router({ mergeParams: true });
          router.get('/items', (_req, res) => { res.status(500).json({}); });
          a.use('/api/grants/:grantId', router);
        });
        report.resetReportStateForTest();
        mockEnvelopes.length = 0;
        await request(app).get('/api/grants/65f0a1b2c3d4e5f6a7b8c9d0/items').expect(500);
        await request(app).get('/api/grants/xk_live_supersecret/items').expect(500);
        await settle();

        const events = eventsSent();
        expect(events).toHaveLength(1);
        expect(events[0].tags.route).toBe('/api/grants/:value/items');
        expect(events[0].fingerprint).toEqual(['5xx', 'GET', '/api/grants/:value/items', '500']);
      });

      it.each([true, false])('a word value under nested param mounts is `:value` (mergeParams %s)', async (merge) => {
        const app = appWith((a) => {
          const inner = express.Router();
          inner.get('/items', (_req, res) => { res.status(500).json({}); });
          const outer = express.Router({ mergeParams: merge });
          outer.use('/:installationId', inner);
          a.use('/api/grants/:grantId', outer);
        });
        await request(app).get('/api/grants/xk_live_supersecret/my-other-secret/items').expect(500);
        await settle();

        const events = eventsSent();
        expect(events).toHaveLength(1);
        expect(events[0].tags.route).toBe('/api/grants/:value/:value/items');
        const wire = JSON.stringify(mockEnvelopes);
        expect(wire).not.toContain('supersecret');
        expect(wire).not.toContain('my-other-secret');
      });

      it('a request no route matched is `unmatched`, never its URL', async () => {
        const app = appWith((a) => {
          a.use((_req, res) => { res.status(502).json({ error: 'Bad Gateway' }); });
        });
        await request(app).get(`/oauth/callback/${TOKEN}?code=${TOKEN}`).expect(502);
        await settle();

        const events = eventsSent();
        expect(events).toHaveLength(1);
        expect(events[0].message).toBe('5xx 502 GET unmatched');
        expect(events[0].tags.route).toBe('unmatched');
        const wire = JSON.stringify(mockEnvelopes);
        expect(wire).not.toContain(TOKEN);
        expect(wire).not.toContain('callback');
      });

      it('a value on the scope does not ride along on a report', async () => {
        const scope = Sentry.getGlobalScope();
        scope.setTag('vendor_token', TOKEN);
        scope.setExtra('vendor', { token: TOKEN });
        scope.setFingerprint([TOKEN]);
        scope.setUser({ id: TOKEN });
        scope.addBreadcrumb({ message: TOKEN });
        try {
          await request(podsApp()).get('/api/pods/a/focus').expect(500);
          await settle();
        } finally {
          scope.clear();
        }
        // The scope reached the SDK's event, so the strip below is what stopped it.
        expect(JSON.stringify(mockRawEvents)).toContain(TOKEN);
        expect(eventsSent()).toHaveLength(1);
        expect(eventsSent()[0].tags).toEqual({
          source: 'handled_5xx', method: 'GET', route: '/api/pods/:id/focus', status: '500',
        });
        expect(JSON.stringify(mockEnvelopes)).not.toContain(TOKEN);
      });
    });

    describe('what leaves besides events', () => {
      it('a cron check-in, which `beforeSend` never sees, does not leave with its slug', async () => {
        Sentry.captureCheckIn({ monitorSlug: TOKEN, status: 'ok' });
        await request(podsApp()).get('/api/pods/a/focus').expect(500);
        await settle();

        const itemTypes = mockEnvelopes.flatMap((envelope) => envelope[1].map(([header]) => header.type));
        expect(itemTypes).toContain('event');
        expect(itemTypes).not.toContain('check_in');
        expect(JSON.stringify(mockEnvelopes)).not.toContain(TOKEN);
      });
    });

    describe('spend', () => {
      const reportFor = (baseUrl) => {
        const res = new (require('events').EventEmitter)();
        res.statusCode = 500;
        const req = {
          method: 'GET', baseUrl, route: { path: '/x' }, originalUrl: `${baseUrl}/x`,
        };
        report.serverErrorReport(req, res, () => {});
        res.emit('finish');
      };
      const word = (i) => `r${i.toString(26).replace(/[0-9]/g, (d) => 'qrstuvwxyz'[d])}`;

      it('stops at the daily cap, and the next UTC day starts over', async () => {
        const capture = jest.spyOn(Sentry, 'captureEvent').mockImplementation(() => 'id');
        for (let i = 0; i < report.DAILY_CAP + 15; i += 1) reportFor(`/api/${word(i)}`);
        expect(capture).toHaveBeenCalledTimes(report.DAILY_CAP);
        expect(report.DAILY_CAP).toBe(60);

        Date.now.mockReturnValue(NOON + 11 * 60 * MINUTE);
        reportFor('/api/after-rollover-one');
        reportFor('/api/after-rollover-two');
        reportFor('/api/after-rollover-three');
        expect(capture).toHaveBeenCalledTimes(report.DAILY_CAP);

        Date.now.mockReturnValue(NOON + 12 * 60 * MINUTE);
        reportFor('/api/next-day');
        expect(capture).toHaveBeenCalledTimes(report.DAILY_CAP + 1);
        expect(report.reportStateForTest()).toEqual({ fingerprints: 1, sentToday: 1 });
      });

      it('one route failing all day cannot spend the cap that every other route needs', () => {
        const capture = jest.spyOn(Sentry, 'captureEvent').mockImplementation(() => 'id');
        const midnight = Date.UTC(2026, 10, 7);
        // Every 15 minutes, 00:00 to 22:45 UTC: 92 windows, each one new.
        for (let at = midnight; at < midnight + 23 * 60 * MINUTE; at += 15 * MINUTE) {
          Date.now.mockReturnValue(at);
          reportFor('/api/always-down');
        }
        expect(capture).toHaveBeenCalledTimes(8);
        expect(report.ROUTE_DAILY_CAP).toBe(8);

        // A different route's first failure, late in the day, still gets through.
        Date.now.mockReturnValue(midnight + 23 * 60 * MINUTE);
        reportFor('/api/first-failure');
        expect(capture).toHaveBeenCalledTimes(9);
        expect(capture.mock.calls.at(-1)[1].data.route).toBe('/api/first-failure/x');
      });

      it('the 15-minute window holds across UTC midnight', () => {
        const capture = jest.spyOn(Sentry, 'captureEvent').mockImplementation(() => 'id');
        Date.now.mockReturnValue(Date.UTC(2026, 10, 7, 23, 59));
        reportFor('/api/late');
        Date.now.mockReturnValue(Date.UTC(2026, 10, 8, 0, 1));
        reportFor('/api/late');
        expect(capture).toHaveBeenCalledTimes(1);

        Date.now.mockReturnValue(Date.UTC(2026, 10, 8, 0, 14));
        reportFor('/api/late');
        expect(capture).toHaveBeenCalledTimes(2);
        // A new day's count starts at zero, carried window or not.
        expect(report.reportStateForTest().sentToday).toBe(1);
      });

      it('a capture counts before send, so a repeat of a failed send does not retry', () => {
        const capture = jest.spyOn(Sentry, 'captureEvent').mockImplementation(() => { throw new Error('boom'); });
        reportFor('/api/flaky');
        reportFor('/api/flaky');
        expect(capture).toHaveBeenCalledTimes(1);
        expect(report.reportStateForTest().sentToday).toBe(1);
      });

      it('a flood of distinct routes cannot grow the dedupe map', () => {
        jest.spyOn(Sentry, 'captureEvent').mockImplementation(() => 'id');
        for (let i = 0; i < 5000; i += 1) reportFor(`/api/${word(i)}`);
        expect(report.reportStateForTest().fingerprints).toBeLessThanOrEqual(report.DAILY_CAP);
      });

      it('a capture that throws does not touch the response or escape `finish`', async () => {
        jest.spyOn(Sentry, 'captureEvent').mockImplementation(() => { throw new Error('boom'); });
        const res = await request(podsApp()).get('/api/pods/a/focus').expect(500);
        expect(res.body).toEqual({ error: 'Server Error' });
      });
    });

    describe('routeOf', () => {
      const routeOf = (baseUrl, routePath) => report.routeOf({
        baseUrl,
        route: routePath === undefined ? undefined : { path: routePath },
      });

      it.each([
        ['/api/pods', '/:id/focus', '/api/pods/:id/focus'],
        ['/api/pods', '/', '/api/pods'],
        ['', '/api/x', '/api/x'],
        ['/api/v1/tasks', '/:taskId?', '/api/v1/tasks/:taskId'],
        ['/api', '/:id(\\d+)', '/api/:value'],
        ['/api', '/files/*', '/api/files/:value'],
        ['/api/42', '/x', '/api/:id/x'],
        ['/api/deadbeef', '/x', '/api/:id/x'],
        ['/API/pods', '/x', '/:value/pods/x'],
        ['/api/a%2Fb', '/x', '/api/:value/x'],
        ['/api/..', '/x', '/api/:value/x'],
        ['/api/a.b', '/x', '/api/:value/x'],
        [`/api/${'z'.repeat(33)}`, '/x', '/api/:value/x'],
        ['/api/eyJhbGciOiJIUzI1NiJ9.e30.abc', '/x', '/api/:value/x'],
      ])('%s + %s = %s', (baseUrl, routePath, expected) => {
        expect(routeOf(baseUrl, routePath)).toBe(expected);
      });

      it('a pattern that is not a string is `:value`', () => {
        expect(routeOf('/api', /\/secret/)).toBe('/api/:value');
        expect(routeOf('/api', ['/a', '/b'])).toBe('/api/:value');
      });

      it('no matched route is `unmatched`, whatever baseUrl holds', () => {
        expect(routeOf('/api/pods', undefined)).toBe('unmatched');
      });

      it('a colon word in the URL text is not a param name', () => {
        expect(routeOf(`/api/:${'k'.repeat(12)}`, '/x')).toBe('/api/:value/x');
      });

      it('a very long route is bounded to what a Sentry tag holds', () => {
        const long = routeOf(Array.from({ length: 40 }, () => `/${'a'.repeat(32)}`).join(''), '/x');
        expect(long.length).toBeLessThanOrEqual(report.MAX_ROUTE_LENGTH);
      });
    });

    describe('beforeSend', () => {
      const beforeSend = (...args) => require('../../../instrument').beforeSend(...args);

      const STACK_HOSTILE = {
        filename: '/app/routes/pods.js',
        function: 'Object.handler',
        lineno: 12,
        colno: 7,
        in_app: true,
        module: `routes.${TOKEN}`,
        vars: { token: TOKEN },
        context_line: `const t = "${TOKEN}";`,
        pre_context: [TOKEN],
        post_context: [TOKEN],
        abs_path: `/somewhere/else/${TOKEN}`,
      };

      it('is the function Sentry.init receives', () => {
        expect(mockInitOptions).toHaveLength(1);
        expect(mockInitOptions[0].beforeSend).toBe(require('../../../instrument').beforeSend);
      });

      it('an event shaped like a report, token in its route, keeps nothing', () => {
        const route = `/api/${TOKEN}`;
        const shaped = {
          event_id: 'e1',
          level: 'error',
          message: `5xx 500 GET ${route}`,
          fingerprint: ['5xx', 'GET', route, '500'],
          tags: {
            source: 'handled_5xx', method: 'GET', route, status: '500',
          },
          transaction: route,
          extra: { serverErrorReport: true, token: TOKEN },
        };

        for (const hint of [
          undefined,
          {},
          { data: { method: 'GET', route, status: 500 } },
          { data: Object.freeze({ method: 'GET', route: '/api/pods', status: 500 }) },
          { data: shaped },
          { data: shaped.tags, event_id: 'e1' },
        ]) {
          const sent = beforeSend(shaped, hint);
          expect(sent).toEqual({ event_id: 'e1', level: 'error', message: 'Unhandled request error' });
          expect(JSON.stringify(sent)).not.toContain(TOKEN);
        }
      });

      it('an unhandled exception keeps no token from its message, value or frame vars', () => {
        const sent = beforeSend({
          message: `failed ${TOKEN}`,
          logentry: { message: TOKEN, params: [TOKEN] },
          exception: {
            values: [{
              type: 'Error',
              value: `failed ${TOKEN}`,
              mechanism: { type: 'generic', data: { token: TOKEN } },
              stacktrace: { frames: [STACK_HOSTILE] },
            }],
          },
          extra: { token: TOKEN },
          contexts: { vendor: { token: TOKEN } },
          breadcrumbs: [{ message: TOKEN }],
          tags: { token: TOKEN },
          fingerprint: [TOKEN],
          transaction: TOKEN,
          threads: { values: [{ stacktrace: { frames: [{ vars: { token: TOKEN } }] } }] },
          modules: { [TOKEN]: '1' },
          some_new_field: TOKEN,
        }, undefined);

        expect(sent).toEqual({
          message: 'Unhandled request error',
          exception: {
            values: [{
              type: 'Error',
              value: 'Unhandled request error',
              stacktrace: {
                frames: [{
                  filename: '/app/routes/pods.js', function: 'Object.handler', lineno: 12, colno: 7, in_app: true,
                }],
              },
            }],
          },
        });
      });

      it('keeps release and environment', () => {
        expect(beforeSend({ release: 'abc', environment: 'production' }, undefined)).toEqual({
          release: 'abc', environment: 'production',
        });
      });

      it('drops a request down to a known method', () => {
        expect(beforeSend({ request: { method: 'GET', url: TOKEN } }, undefined)).toEqual({ request: { method: 'GET' } });
        expect(beforeSend({ request: { method: TOKEN } }, undefined)).toEqual({});
      });

      const frameThrough = (frame) => {
        const sent = beforeSend({ exception: { values: [{ type: 'Error', stacktrace: { frames: [frame] } }] } }, undefined);
        return sent.exception.values[0].stacktrace?.frames[0];
      };

      it.each([
        ['a data: URL', `data:text/javascript;base64,${TOKEN}`],
        ['a query string', `/app/routes/x.js?token=${TOKEN}`],
        ['a fragment', `/app/routes/x.js#${TOKEN}`],
        ['an http URL', `https://cdn.example/${TOKEN}.js`],
        ['a generated file', `/app/tmp/${TOKEN}.js`],
        ['a relative name', TOKEN],
        ['an anonymous eval', '<anonymous>'],
      ])('drops a filename that is %s and keeps the frame', (_label, filename) => {
        const frame = frameThrough({ filename, function: 'handler', lineno: 3 });
        expect(frame).toEqual({ function: 'handler', lineno: 3 });
      });

      it.each([
        ['an app file', '/app/routes/pods.js'],
        ['a dependency', '/app/node_modules/@sentry/core/build/cjs/client.js'],
        ['a Node internal', 'node:internal/process/task_queues'],
        ['a rewritten app frame', 'app:///routes/pods.js'],
      ])('keeps a filename that is %s', (_label, filename) => {
        expect(frameThrough({ filename, lineno: 1 })).toEqual({ filename, lineno: 1 });
      });

      it.each([
        ['eval text', `eval at handler (/app/x.js:1:1), ${TOKEN}`],
        ['a generated name', TOKEN],
        ['a generated method', `Object.${TOKEN}`],
        ['a name with spaces', `callback ${TOKEN}`],
        ['a URL', `https://x/${TOKEN}`],
      ])('drops a function that is %s and keeps the frame', (_label, name) => {
        const frame = frameThrough({ filename: '/app/routes/x.js', function: name, lineno: 3 });
        expect(frame).toEqual({ filename: '/app/routes/x.js', lineno: 3 });
      });

      it.each([
        ['handler'],
        ['Object.<anonymous>'],
        ['new Promise'],
        ['async Layer.handle'],
        ['Router.<computed>'],
        ['$injected_name'],
        ['ensureAgentInPodAndInstallation'],
      ])('keeps the function %s', (name) => {
        expect(frameThrough({ function: name })).toEqual({ function: name });
      });

      it('reduces `Layer.handle [as handle_request]` to the plain name', () => {
        expect(frameThrough({ function: 'Layer.handle [as handle_request]' })).toEqual({ function: 'Layer.handle' });
      });

      it('a frame left with no place to point at is dropped', () => {
        expect(frameThrough({ filename: TOKEN, function: TOKEN, lineno: 3, vars: { a: 1 } })).toBeUndefined();
      });

      it('keeps abs_path only under the app', () => {
        const appRoot = path.resolve(__dirname, '../../..');
        const inside = `${appRoot}/routes/pods.js`;
        expect(frameThrough({ function: 'f', abs_path: inside })).toEqual({ function: 'f', abs_path: inside });
        expect(frameThrough({ function: 'f', abs_path: '/etc/passwd' })).toEqual({ function: 'f' });
        expect(frameThrough({ function: 'f', abs_path: `${appRoot}-evil/x.js` })).toEqual({ function: 'f' });
        expect(frameThrough({ function: 'f', abs_path: `${appRoot}/x.js?t=${TOKEN}` })).toEqual({ function: 'f' });
      });

      it('line and column survive only as numbers, in_app only as a boolean', () => {
        expect(frameThrough({
          function: 'f', lineno: TOKEN, colno: TOKEN, in_app: TOKEN,
        })).toEqual({ function: 'f' });
      });

      it.each([
        ['TypeError', 'TypeError'],
        ['AxiosError', 'AxiosError'],
        [`failed: ${TOKEN}`, 'Error'],
        [TOKEN, 'Error'],
        ['', 'Error'],
        [undefined, 'Error'],
      ])('type %s reads as %s', (type, expected) => {
        const sent = beforeSend({ exception: { values: [{ type, value: TOKEN }] } }, undefined);
        expect(sent.exception.values).toEqual([{ type: expected, value: 'Unhandled request error' }]);
      });

      it('every linked error keeps its frames', () => {
        const sent = beforeSend({
          exception: {
            values: [
              { type: 'TypeError', value: TOKEN, stacktrace: { frames: [{ function: 'inner', lineno: 1 }] } },
              { type: 'Error', value: TOKEN, stacktrace: { frames: [{ function: 'outer', lineno: 2 }] } },
            ],
          },
        }, undefined);
        expect(sent.exception.values.map((value) => value.stacktrace.frames[0].function)).toEqual(['inner', 'outer']);
        expect(JSON.stringify(sent)).not.toContain(TOKEN);
      });

      it('through the real SDK: frames arrive, source lines added by context-lines do not', async () => {
        const app = appWith((a) => {
          a.get('/boom', () => {
            const cause = new Error(`vendor said ${TOKEN}`);
            const error = new Error(`upstream said ${TOKEN}`, { cause });
            error.token = TOKEN;
            throw error;
          });
        });
        await request(app).get(`/boom?code=${TOKEN}`).expect(500);
        await settle();

        const rawFrames = mockRawEvents[0].exception.values.flatMap((value) => value.stacktrace.frames);
        expect(rawFrames.some((frame) => frame.context_line)).toBe(true);

        const events = eventsSent();
        expect(events).toHaveLength(1);
        const frames = events[0].exception.values.flatMap((value) => value.stacktrace.frames);
        expect(frames.length).toBeGreaterThan(0);
        // This frame's filename is the checkout path. `looksGenerated` drops a
        // filename with a segment that looks generated (16+ chars, 5+ digits, as
        // a UUID-named temp or scratch dir is), so the filename is asserted only
        // from a checkout path without such a segment; the frame's position
        // survives either way.
        const generatedSegment = __filename.split('/').some((segment) => (
          segment.length > 64 || (segment.length >= 16 && segment.replace(/\D/g, '').length >= 5)
        ));
        expect(frames.some((frame) => Number.isInteger(frame.lineno))).toBe(true);
        if (!generatedSegment) {
          expect(frames.some((frame) => frame.filename?.endsWith('serverErrorReport.test.js') && frame.in_app)).toBe(true);
        }
        for (const frame of frames) {
          expect(Object.keys(frame).every((key) => ['filename', 'function', 'lineno', 'colno', 'in_app', 'abs_path'].includes(key))).toBe(true);
        }
        expect(JSON.stringify(mockEnvelopes)).not.toContain(TOKEN);
      });
    });
  });

  // F326: a thrown error keeps its frames and now says where it happened: the
  // route pattern, built as a 5xx report's is, never the URL that held a token.
  describe('the route of a thrown error', () => {
    // The block above closed its client, and instrument.ts inits only on its
    // first load, so this one starts its own with the same `beforeSend`.
    beforeAll(() => {
      process.env.SENTRY_DSN = 'https://public@sentry.invalid/1';
      Sentry.init({ dsn: process.env.SENTRY_DSN, beforeSend: require('../../../instrument').beforeSend });
    });
    afterAll(async () => {
      delete process.env.SENTRY_DSN;
      await Sentry.close(100);
    });
    beforeEach(() => { report.resetReportStateForTest(); });

    const thrownApp = () => appWith((app) => {
      const router = express.Router();
      router.get('/:id/throws', () => { throw new Error(`upstream said ${TOKEN}`); });
      router.get('/:id/async', async () => { throw new Error(`upstream said ${TOKEN}`); });
      router.get('/:id/next', (_req, _res, next) => { next(new Error(`upstream said ${TOKEN}`)); });
      app.use('/api/pods', router);
      const keyed = express.Router({ mergeParams: true });
      keyed.get('/use', () => { throw new Error('boom'); });
      app.use('/api/keys/:key', keyed);
      app.use('/api/early', () => { throw new Error(`no route ${TOKEN}`); });
    });

    it.each(['throws', 'async', 'next'])('names the endpoint of a %s error, and never its URL', async (how) => {
      await request(thrownApp()).get(`/api/pods/${TOKEN}/${how}?code=${TOKEN}`).expect(500);
      await settle();
      const events = eventsSent();
      expect(events).toHaveLength(1);
      expect(events[0].tags).toEqual({ source: 'unhandled', method: 'GET', route: `/api/pods/:id/${how}` });
      expect(events[0].transaction).toBe(`GET /api/pods/:id/${how}`);
      expect(events[0].exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
      expect(JSON.stringify(mockEnvelopes)).not.toContain(TOKEN);
    });

    it('a word-shaped value in a mount is `:value`, not the value', async () => {
      await request(thrownApp()).get('/api/keys/sk_live_abc/use').expect(500);
      await settle();
      const [event] = eventsSent();
      expect(event.tags.route).toBe('/api/keys/:value/use');
      expect(JSON.stringify(mockEnvelopes)).not.toContain('sk_live_abc');
    });

    it('an error before any route matched is `unmatched`', async () => {
      await request(thrownApp()).get(`/api/early/${TOKEN}`).expect(500);
      await settle();
      const [event] = eventsSent();
      expect(event.tags).toEqual({ source: 'unhandled', method: 'GET', route: 'unmatched' });
      expect(JSON.stringify(mockEnvelopes)).not.toContain(TOKEN);
    });

    // accessLog watches `req.route` too and is mounted first (server.ts). The
    // route watch here chains to it: replacing it logged every line `<unmatched>`.
    it('the access log mounted before it still logs every route, and the error still names its own', async () => {
      const { createAccessLog } = require('../../../middleware/accessLog');
      const lines = [];
      const { attachSentryErrorHandler } = require('../../../instrument');
      const app = express();
      app.use(createAccessLog({ enabled: true, secret: 's', log: (line) => lines.push(JSON.parse(line)) }));
      app.use(report.serverErrorReport);
      const router = express.Router();
      router.get('/:id/ok', (_req, res) => { res.json({}); });
      router.get('/:id/throws', () => { throw new Error('boom'); });
      app.use('/api/pods', router);
      attachSentryErrorHandler(app);
      app.use(require('../../../middleware/finalErrorHandler').finalErrorHandler);

      await request(app).get('/api/pods/abc/ok').expect(200);
      await request(app).get('/api/pods/abc/throws').expect(500);
      await settle();
      expect(lines.map((line) => line.route)).toEqual(['/api/pods/:id/ok', '/api/pods/:id/throws']);
      expect(eventsSent()[0].tags.route).toBe('/api/pods/:id/throws');
    });

    it('an error object nobody routed names nothing, whatever it carries', () => {
      const beforeSend = require('../../../instrument').beforeSend;
      const stray = Object.assign(new Error('x'), { method: 'GET', route: `/api/${TOKEN}` });
      const sent = beforeSend({ exception: { values: [{ type: 'Error', value: 'x' }] } }, { originalException: stray });
      expect(sent).not.toHaveProperty('tags');
      expect(sent).not.toHaveProperty('transaction');
    });
  });

  describe('where it is mounted', () => {
    const server = fs.readFileSync(path.join(__dirname, '../../../server.ts'), 'utf8');

    it('is a leaf: instrument.ts loads it first, so it imports no app module and no express', () => {
      const source = fs.readFileSync(path.join(__dirname, '../../../services/serverErrorReport.ts'), 'utf8');
      const runtimeImports = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]).sort();
      expect(runtimeImports).toEqual(['@sentry/node', 'path']);
      expect(source).not.toMatch(/^import (?!type )/m);
    });

    it('runs before anything that can refuse a request', () => {
      const mounted = server.indexOf('app.use(serverErrorReport);');
      expect(mounted).toBeGreaterThan(-1);
      expect(mounted).toBeLessThan(server.indexOf('app.use(cors(corsOptions(allowedOrigins)));'));
    });
  });
});
