// F568: a malformed pod id answers 400 in every router that casts it.
//
// F566 guarded the registry after a PowerShell call sent `/pods/=default`. A
// sweep of the other routers found six more that cast the id unguarded and
// answer a bare 500 (a Mongoose CastError in each catch-all), and one that
// answered 400 but sent the CastError's own text back to the caller.
//
// The models are real and there is no database: Mongoose casts the id before
// it needs a connection, so the CastError a malformed id throws in prod is the
// one thrown here.
const express = require('express');
const request = require('supertest');

// `x-test-signed-out` makes auth refuse, which proves a request with a
// well-formed id got past the guard to the route.
const asUser = (req, res, next) => {
  if (req.headers['x-test-signed-out']) return res.status(401).json({ code: 'signed_out' });
  req.user = { id: '6a0000000000000000000001', _id: '6a0000000000000000000001' };
  req.userId = '6a0000000000000000000001';
  req.agentUser = { _id: '6a0000000000000000000002' };
  return next();
};
jest.mock('../../../middleware/auth', () => asUser);
jest.mock('../../../middleware/agentRuntimeAuth', () => asUser);
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

const mount = (prefix, name) => {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const router = require(`../../../routes/${name}`);
  app.use(prefix, router.default || router);
  return app;
};

const ROUTERS = {
  'admin/pods': mount('/api/admin/pods', 'admin/pods'),
  agentEnsemble: mount('/api/pods', 'agentEnsemble'),
  apps: mount('/api/apps', 'apps'),
  contextApi: mount('/api/v1', 'contextApi'),
  discord: mount('/api/discord', 'discord'),
  federation: mount('/api/federation', 'federation'),
  summaries: mount('/api/summaries', 'summaries'),
};

const ID = '6a00000000000000000000a1';

// Every pod-id route in each router, with a body valid enough to reach the
// cast where the route checks its body first.
const ROUTES = [
  ['admin/pods', 'post', '/api/admin/pods/:podId/showcase', { publicRead: true }],
  ['admin/pods', 'post', '/api/admin/pods/:podId/listing', { listed: true }],
  ['agentEnsemble', 'post', '/api/pods/:podId/ensemble/start'],
  ['agentEnsemble', 'post', '/api/pods/:podId/ensemble/pause'],
  ['agentEnsemble', 'post', '/api/pods/:podId/ensemble/resume'],
  ['agentEnsemble', 'post', '/api/pods/:podId/ensemble/complete'],
  ['agentEnsemble', 'get', '/api/pods/:podId/ensemble/state'],
  ['agentEnsemble', 'patch', '/api/pods/:podId/ensemble/config'],
  ['agentEnsemble', 'get', '/api/pods/:podId/ensemble/history'],
  ['agentEnsemble', 'post', '/api/pods/:podId/ensemble/response'],
  ['apps', 'get', '/api/apps/pods/:podId/apps'],
  ['apps', 'post', '/api/apps/pods/:podId/apps'],
  ['apps', 'delete', `/api/apps/pods/:podId/apps/${ID}`],
  ['contextApi', 'get', '/api/v1/pods/:podId'],
  ['contextApi', 'get', '/api/v1/context/:podId'],
  ['contextApi', 'get', '/api/v1/search/:podId?q=x'],
  ['contextApi', 'post', '/api/v1/pods/:podId/index/rebuild'],
  ['contextApi', 'get', '/api/v1/pods/:podId/index/stats'],
  ['contextApi', 'get', `/api/v1/pods/:podId/assets/${ID}`],
  ['contextApi', 'get', '/api/v1/pods/:podId/memory/notes.md'],
  ['contextApi', 'post', '/api/v1/memory/:podId'],
  ['contextApi', 'get', '/api/v1/pods/:podId/skills'],
  ['contextApi', 'get', '/api/v1/pods/:podId/summaries'],
  ['discord', 'get', '/api/discord/install-link/:podId'],
  ['discord', 'get', '/api/discord/binding/:podId'],
  ['federation', 'get', '/api/federation/pods/:podId/links'],
  ['federation', 'get', '/api/federation/pods/:podId/requests'],
  ['federation', 'get', '/api/federation/pods/:podId/accessible'],
  ['summaries', 'get', '/api/summaries/pod/:podId'],
  ['summaries', 'post', '/api/summaries/pod/:podId/refresh'],
];

describe('F568: a non-ObjectId pod id answers 400 outside the registry too', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  test.each(ROUTES)('%s %s %s', async (router, method, path, body = {}) => {
    const res = await request(ROUTERS[router])[method](path.replace(':podId', '=default')).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
    expect(JSON.stringify(res.body)).not.toMatch(/Cast to ObjectId/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test.each([':podId', '6a0000aa', 'nonsense', `${ID}f`])('the id %s answers 400', async (id) => {
    const res = await request(ROUTERS.summaries).get(`/api/summaries/pod/${id}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
  });

  test.each(ROUTES)('a well-formed id goes on to the route: %s %s %s', async (router, method, path, body = {}) => {
    const res = await request(ROUTERS[router])[method](path.replace(':podId', ID.toUpperCase()))
      .set('x-test-signed-out', '1').send(body);
    expect(res.status).toBe(401);
  });
});
