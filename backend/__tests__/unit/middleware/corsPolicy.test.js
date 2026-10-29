/**
 * The API's CORS policy, on a real Express app with the app's own final error
 * handler: a disallowed origin is refused with 403 before any route runs (it
 * was a 500), and commonly.me, local dev and origin-less callers still work.
 */
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const { buildAllowedOrigins, corsOptions } = require('../../../middleware/corsPolicy');
const { finalErrorHandler } = require('../../../middleware/finalErrorHandler');

const ALLOWED = ['http://localhost:3000', 'https://commonly.me'];

const build = () => {
  const reached = [];
  const app = express();
  app.use(cors(corsOptions(ALLOWED)));
  app.get('/api/pods', (req, res) => {
    reached.push(`GET ${req.headers.origin || '-'}`);
    res.json({ ok: true });
  });
  app.post('/api/messages/pod1', (req, res) => {
    reached.push(`POST ${req.headers.origin || '-'}`);
    res.json({ ok: true });
  });
  app.use(finalErrorHandler);
  return { app, reached };
};

const preflight = (app, origin) => request(app)
  .options('/api/pods')
  .set('Origin', origin)
  .set('Access-Control-Request-Method', 'GET')
  .set('Access-Control-Request-Headers', 'authorization');

describe('CORS policy', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('refuses a preflight from another origin with 403, not 500, and grants nothing', async () => {
    const { app } = build();
    const res = await preflight(app, 'http://127.0.0.1:4173');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses a request from another origin before any route runs', async () => {
    const { app, reached } = build();
    const get = await request(app).get('/api/pods').set('Origin', 'https://elsewhere.example');
    // A form-style POST needs no preflight, so the refusal must come from the request itself.
    const post = await request(app)
      .post('/api/messages/pod1')
      .set('Origin', 'https://elsewhere.example')
      .type('form')
      .send('content=hi');
    expect([get.status, post.status]).toEqual([403, 403]);
    expect(reached).toEqual([]);
  });

  it('treats an opaque "null" origin as another origin', async () => {
    const { app, reached } = build();
    const res = await request(app).get('/api/pods').set('Origin', 'null');
    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  it('answers a preflight from commonly.me with its origin, credentials and the methods the shell uses', async () => {
    const { app } = build();
    const res = await preflight(app, 'https://commonly.me');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://commonly.me');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type,Authorization,x-auth-token');
  });

  it('serves commonly.me and local dev with their own origin echoed', async () => {
    const { app, reached } = build();
    const shell = await request(app).get('/api/pods').set('Origin', 'https://commonly.me');
    const dev = await request(app).get('/api/pods').set('Origin', 'http://localhost:3000');
    expect([shell.status, dev.status]).toEqual([200, 200]);
    expect(shell.headers['access-control-allow-origin']).toBe('https://commonly.me');
    expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(reached).toEqual(['GET https://commonly.me', 'GET http://localhost:3000']);
  });

  it('serves a caller that sends no Origin (agents, webhooks, curl)', async () => {
    const { app, reached } = build();
    const res = await request(app).post('/api/messages/pod1').send({ content: 'hi' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(reached).toEqual(['POST -']);
  });
});

describe('buildAllowedOrigins', () => {
  it('reads a comma-separated FRONTEND_URL, trimming blanks', () => {
    expect(buildAllowedOrigins(' https://commonly.me , ,http://localhost:3000')).toEqual(['https://commonly.me', 'http://localhost:3000']);
  });

  it('falls back to local dev and the production shell when unset or blank', () => {
    expect(buildAllowedOrigins('')).toEqual(ALLOWED);
    expect(buildAllowedOrigins('   ')).toEqual(ALLOWED);
  });
});
