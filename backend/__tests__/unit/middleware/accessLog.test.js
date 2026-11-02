/**
 * The access log (F57): one line per answered request, built from the route
 * template, never from the URL. A real Express app with nested routers, so the
 * template is what Express resolved, not what a mock assumed.
 */
const express = require('express');
const request = require('supertest');
const { createHash, createHmac } = require('crypto');
const { createAccessLog, callerHash } = require('../../../middleware/accessLog');

const SECRET = 'access-log-test-secret';
const USER = '6a47891ee025ce2e0ca1d30b';
const OTHER = '6aaed1c9b7f5a0805971668f';

const buildApp = (lines, opts = {}) => {
  const app = express();
  app.use(createAccessLog({
    log: (line) => lines.push(JSON.parse(line)), secret: SECRET, enabled: true, ...opts, 
  }));
  // A stand-in for middleware/auth: the caller is whoever the header names.
  const asCaller = (req, _res, next) => {
    if (req.headers['x-test-user']) req.userId = req.headers['x-test-user'];
    if (req.headers['x-test-agent']) req.agentUser = { _id: req.headers['x-test-agent'] };
    next();
  };
  const users = express.Router();
  users.get('/:id/public-activity', asCaller, (req, res) => res.json({ ok: true }));
  users.get('/:id/fail', asCaller, () => { throw new Error('boom'); });
  users.get('/:id', asCaller, (req, res) => res.status(404).json({ msg: 'User not found' }));
  const runtime = express.Router();
  runtime.get('/pods/:podId/context', asCaller, (req, res) => setTimeout(() => res.json({}), 15));
  const agents = express.Router();
  agents.use('/runtime', runtime);
  app.use('/api/users', users);
  app.use('/api/agents', agents);
  app.get('/api/health/live', (req, res) => res.json({ ok: true }));
  app.get('/api/health/ready', (req, res) => res.json({ ok: true }));
  app.get('/api/boom', () => { throw new Error('boom'); });
  return app;
};

// The line is written on the response's `finish`, which supertest can resolve
// before, and by more than one turn of the loop on a loaded host. `logged`
// waits for the lines a test expects; `settled` gives a test that expects none
// the same chance to be wrong.
const logged = (lines, count = 1, tries = 200) => new Promise((resolve) => {
  const check = (left) => (lines.length >= count || left === 0
    ? resolve() : setTimeout(() => check(left - 1), 10));
  check(tries);
});
const settled = () => new Promise((resolve) => { setTimeout(resolve, 50); });

describe('access log', () => {
  it('writes the route template, status and latency, never the raw path or query', async () => {
    const lines = [];
    await request(buildApp(lines))
      .get(`/api/users/${OTHER}/public-activity?limit=8&token=abc`)
      .set('x-test-user', USER)
      .expect(200);
    await logged(lines);

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      log: 'access', method: 'GET', route: '/api/users/:id/public-activity', status: 200, self: false,
    });
    expect(typeof line.ms).toBe('number');
    const text = JSON.stringify(line);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(USER);
    expect(text).not.toContain('limit');
    expect(text).not.toContain('abc');
  });

  it('hashes the caller with a keyed hash, so a list of user ids cannot reverse it', async () => {
    const lines = [];
    await request(buildApp(lines)).get(`/api/users/${OTHER}/public-activity`).set('x-test-user', USER);
    await logged(lines);

    const expected = createHmac('sha256', SECRET).update(`access-log\u0000${USER}`).digest('hex').slice(0, 16);
    expect(lines[0].caller).toBe(expected);
    expect(callerHash(USER, SECRET)).toBe(expected);
    // An unkeyed hash of the id is exactly what someone holding the user list could recompute.
    const unkeyed = createHash('sha256').update(USER).digest('hex');
    expect(lines[0].caller).not.toBe(unkeyed.slice(0, 16));
  });

  it('marks a request about the caller itself as self', async () => {
    const lines = [];
    await request(buildApp(lines)).get(`/api/users/${USER}/public-activity`).set('x-test-user', USER);
    await logged(lines);
    expect(lines[0]).toMatchObject({ route: '/api/users/:id/public-activity', self: true });
  });

  it('names a nested router by its full template and takes an agent as the caller', async () => {
    const lines = [];
    await request(buildApp(lines)).get('/api/agents/runtime/pods/abc123/context').set('x-test-agent', OTHER);
    await logged(lines);
    expect(lines[0]).toMatchObject({ route: '/api/agents/runtime/pods/:podId/context', status: 200 });
    expect(lines[0].caller).toBe(callerHash(OTHER, SECRET));
    expect(lines[0].ms).toBeGreaterThanOrEqual(10);
  });

  it('logs an unrouted request without its path, and a signed-out one without a caller', async () => {
    const lines = [];
    await request(buildApp(lines)).get(`/api/nowhere/${OTHER}`).expect(404);
    await logged(lines);
    expect(lines).toEqual([expect.objectContaining({
      route: '<unmatched>', status: 404, caller: null, self: false, 
    })]);
    expect(JSON.stringify(lines)).not.toContain(OTHER);
  });

  it('keeps the template for a handler that throws', async () => {
    const lines = [];
    await request(buildApp(lines)).get('/api/boom').expect(500);
    await logged(lines);
    expect(lines[0]).toMatchObject({ route: '/api/boom', status: 500 });
  });

  it('keeps the mount prefix when an error unwinds a nested router', async () => {
    // Express restores req.baseUrl as the error leaves /api/users, so a template
    // read at `finish` would say `/:id/fail`.
    const lines = [];
    await request(buildApp(lines)).get(`/api/users/${OTHER}/fail`).expect(500);
    await logged(lines);
    expect(lines[0]).toMatchObject({ route: '/api/users/:id/fail', status: 500 });
  });

  it('names a mount typed in another case by its lowercase template', async () => {
    const lines = [];
    await request(buildApp(lines)).get(`/API/Users/${OTHER}/public-activity`).expect(200);
    await logged(lines);
    expect(lines[0].route).toBe('/api/users/:id/public-activity');
  });

  it('waits for a line written after the response, as on a loaded host', async () => {
    // The line is held until the test releases it, so the wait is checked at a
    // moment the test chooses rather than one a timer races the request to.
    const lines = [];
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const late = (line) => { held.then(() => lines.push(JSON.parse(line))); };
    await request(buildApp(lines, { log: late })).get(`/api/users/${OTHER}/public-activity`).expect(200);
    let done = false;
    const waiting = logged(lines).then(() => { done = true; });
    // Several 10ms polls: a wait that gives up after one would have resolved.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(done).toBe(false);
    release();
    await waiting;
    expect(lines).toEqual([expect.objectContaining({ route: '/api/users/:id/public-activity', status: 200 })]);
  });

  it('skips the health probes', async () => {
    const lines = [];
    const app = buildApp(lines);
    await request(app).get('/api/health/live');
    await request(app).get('/api/health/ready');
    await settled();
    expect(lines).toEqual([]);
  });

  it('writes nothing when switched off, and nothing under jest by default', async () => {
    const off = [];
    await request(buildApp(off, { enabled: false })).get(`/api/users/${OTHER}/public-activity`);
    const byDefault = [];
    const app = express();
    app.use(createAccessLog({ log: (line) => byDefault.push(line), secret: SECRET }));
    app.get('/x', (req, res) => res.json({}));
    await request(app).get('/x');
    await settled();
    expect(off).toEqual([]);
    expect(byDefault).toEqual([]);
  });
});
