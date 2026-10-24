// @ts-nocheck
// refuseDollarKeys: request keys starting with `$` are refused with 400, in the
// query string and the body, at any depth, with two narrow body exemptions.
// The app below mirrors server.ts's order: route-specific parsers first, then
// the global express.json(), then the guard, then the routes.

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const request = require('supertest');
const { refuseDollarKeys, findDollarKey, DOLLAR_KEY_REFUSED } = require('../../../middleware/refuseDollarKeys');

const buildApp = () => {
  const app = express();
  app.use('/raw', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(refuseDollarKeys);
  const ok = (req, res) => res.json({ ok: true });
  app.get('/x', ok);
  app.post('/x', ok);
  app.post('/raw', ok);
  app.post('/api/marketplace/publish', ok);
  app.put('/api/marketplace/publish', ok);
  app.post('/api/webhooks/slack/events', ok);
  // A multipart route, as pods.ts and uploads.ts have: multer parses its
  // fields after the global guard, so the route runs the guard again.
  app.post('/multipart', multer().none(), refuseDollarKeys, ok);
  app.post('/multipart-unguarded', multer().none(), (req, res) => res.json({ body: req.body }));
  return app;
};

describe('refuseDollarKeys', () => {
  const app = buildApp();

  test.each([
    ['a nested query operator', '/x?a[$ne]=1', 'query.a.$ne'],
    ['a top-level query key', '/x?$where=1', 'query.$where'],
    ['a query key inside an array', '/x?a[0][$gt]=1', 'query.a.0.$gt'],
  ])('refuses %s', async (_label, url, field) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: DOLLAR_KEY_REFUSED, field });
  });

  test('refuses a body key at any depth, arrays included', async () => {
    const res = await request(app).post('/x').send({ a: { b: [{ c: 1 }, { $gt: 1 }] } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: DOLLAR_KEY_REFUSED, field: 'body.a.b.1.$gt' });
  });

  test('passes `$` in values, and in keys that do not start with it', async () => {
    const res = await request(app).post('/x?q=$5').send({ price: '$5', a$b: 1, list: ['$x'] });
    expect(res.status).toBe(200);
  });

  test('does not inspect a raw Buffer body (signature-verified webhooks)', async () => {
    const res = await request(app).post('/raw').set('Content-Type', 'application/json').send('{"$schema":"x"}');
    expect(res.status).toBe(200);
  });

  test('a deeply nested body does not exhaust the stack', async () => {
    let body = { leaf: 1 };
    for (let i = 0; i < 5000; i += 1) body = { n: body };
    const res = await request(app).post('/x').send(body);
    expect(res.status).toBe(200);
  });

  describe('marketplace publish: JSON Schema keywords in schema fields only', () => {
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { a: { type: 'string' } }, properties: { x: { $ref: '#/$defs/a' } } };

    test('allows keywords in widgetConfigSchema and schemaFields, at any depth', async () => {
      const res = await request(app).post('/api/marketplace/publish')
        .send({ components: [{ widgetConfigSchema: schema }, { schemaFields: { $id: 'f' } }] });
      expect(res.status).toBe(200);
    });

    test.each([
      ['a non-keyword in a schema field', { components: [{ widgetConfigSchema: { $ne: 1 } }] }, 'body.components.0.widgetConfigSchema.$ne'],
      ['a keyword in another component field', { components: [{ metadata: { $schema: 'x' } }] }, 'body.components.0.metadata.$schema'],
      ['a keyword outside components', { $schema: 'x' }, 'body.$schema'],
      ['a non-keyword nested under a keyword', { components: [{ widgetConfigSchema: { $defs: { $where: 1 } } }] }, 'body.components.0.widgetConfigSchema.$defs.$where'],
    ])('refuses %s', async (_label, body, field) => {
      const res = await request(app).post('/api/marketplace/publish').send(body);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
    });

    test('the exemption is POST /api/marketplace/publish only', async () => {
      const body = { components: [{ widgetConfigSchema: schema }] };
      expect((await request(app).put('/api/marketplace/publish').send(body)).status).toBe(400);
      expect((await request(app).post('/x').send(body)).status).toBe(400);
    });
  });

  describe('slack webhooks: event.metadata.event_payload is the sending app\'s', () => {
    test('allows any key under event_payload', async () => {
      const res = await request(app).post('/api/webhooks/slack/events')
        .send({ event: { type: 'message', metadata: { event_type: 't', event_payload: { $a: { $b: 1 } } } } });
      expect(res.status).toBe(200);
    });

    test('refuses a key elsewhere in the event', async () => {
      const res = await request(app).post('/api/webhooks/slack/events').send({ event: { $x: 1 } });
      expect(res.status).toBe(400);
    });
  });

  describe('multipart fields', () => {
    test('multer builds nested objects from bracketed field names, which is why it needs its own check', async () => {
      const res = await request(app).post('/multipart-unguarded').field('podId[$ne]', 'x');
      expect(res.body.body).toEqual({ podId: { $ne: 'x' } });
    });

    test('the check after multer refuses them', async () => {
      const res = await request(app).post('/multipart').field('podId[$ne]', 'x');
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('body.podId.$ne');
    });
  });
});

describe('findDollarKey', () => {
  test('null for strings, Buffers and null', () => {
    expect(findDollarKey('$x')).toBeNull();
    expect(findDollarKey(Buffer.from('{"$x":1}'))).toBeNull();
    expect(findDollarKey(null)).toBeNull();
  });

  test('counts null-prototype objects (what qs builds) as plain', () => {
    const o = Object.create(null);
    o.$ne = 1;
    expect(findDollarKey({ a: o })).toBe('a.$ne');
  });
});

describe('where the guard is mounted', () => {
  const src = (p) => fs.readFileSync(path.join(__dirname, '../../..', p), 'utf8');

  test('server.ts: after the global express.json() and before the first route', () => {
    const server = src('server.ts');
    const json = server.indexOf('app.use(express.json());');
    const guard = server.indexOf('app.use(refuseDollarKeys);');
    const firstRoute = server.indexOf("app.use('/api/auth'");
    expect(json).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(json);
    expect(firstRoute).toBeGreaterThan(guard);
  });

  test('both multipart routes run it after multer', () => {
    expect(src('routes/pods.ts')).toMatch(/upload\.single\('qrCode'\), refuseDollarKeys,/);
    expect(src('routes/uploads.ts')).toMatch(/return refuseDollarKeys\(req as never, res as never, next as never\);/);
  });
});
