// F566: a registry path whose pod id is not an ObjectId answers 400, not 500.
//
// On 2026-11-23 UTC a Windows PowerShell call meant `.../pods/$podId?instanceId=default`.
// PowerShell 5.1 reads `$podId?instanceId` as one variable name, so the URL
// arrived as `/api/registry/agents/<name>/pods/=default`. The handler cast
// "=default" to an ObjectId, Mongoose threw a CastError, and the catch-all
// answered 500 with nothing the caller could act on. F330 added the 400 guard
// to the pods routes; the registry never used it.
//
// The models are real and there is no database: Mongoose casts the id before
// it needs a connection, so the CastError prod threw is the one thrown here.
const express = require('express');
const request = require('supertest');

// `x-test-signed-out` makes auth refuse, which proves a request got past the
// guard to the route without the route touching a database.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (req.headers['x-test-signed-out']) return res.status(401).json({ code: 'signed_out' });
  req.user = { id: '6a0000000000000000000001' };
  req.userId = '6a0000000000000000000001';
  next();
});

const app = express();
app.use(express.json());
app.use('/api/registry', require('../../../routes/registry'));

describe('F566: a non-ObjectId pod id in a registry path answers 400', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  test.each(['=default', ':podId', '6a0000aa'])('DELETE /agents/scout/pods/%s (the 11-23 call)', async (id) => {
    const res = await request(app)
      .delete(`/api/registry/agents/scout/pods/${encodeURIComponent(id)}?instanceId=default`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // One route from each router that takes a pod id, including runtime, which
  // is mounted above the shared rate limit.
  test.each([
    ['get', '/pods/=default/agents'],
    ['get', '/pods/=default/agents/scout'],
    ['patch', '/pods/=default/agents/scout'],
    ['get', '/pods/=default/agents/scout/runtime-tokens'],
    ['get', '/pods/=default/agents/scout/heartbeat-file'],
    ['get', '/pods/=default/agents/scout/plugins'],
    ['post', '/pods/=default/agents/scout/provision'],
    ['get', '/pods/=default/agents/scout/runtime-status'],
    // Valid bodies, so these reach the cast and not the body check first.
    ['patch', '/agents/scout/manage-settings/pods/=default', {
      wakeOnMessage: true, humanOnly: false, boardWake: false, heartbeatEnabled: false,
    }],
    ['put', '/agents/scout/manage-settings/pods/=default/schedule', { enabled: false }],
  ])('%s %s', async (method, path, body = {}) => {
    const res = await request(app)[method](`/api/registry${path}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['delete', '/agents/scout/pods/6a00000000000000000000aa?instanceId=default'],
    ['get', '/pods/6a00000000000000000000aa/agents'],
    ['get', '/pods/6A00000000000000000000AA/agents/scout/runtime-status'],
  ])('a well-formed pod id goes on to the route: %s %s', async (method, path) => {
    const res = await request(app)[method](`/api/registry${path}`).set('x-test-signed-out', '1');
    expect(res.status).toBe(401);
  });

  // Install answers a malformed id with its own 404, pinned in
  // registry.add-agent-to-pod.test.js; the guard leaves it alone.
  test('install on the same path keeps its own answer', async () => {
    const res = await request(app).post('/api/registry/agents/scout/pods/=default').set('x-test-signed-out', '1');
    expect(res.status).toBe(401);
  });

  test('a registry path with no pod id is untouched', async () => {
    const res = await request(app).get('/api/registry/agents/=default/manage-settings').set('x-test-signed-out', '1');
    expect(res.status).toBe(401);
  });
});
