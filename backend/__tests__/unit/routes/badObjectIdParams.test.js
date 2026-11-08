// F330: a path segment that is not an ObjectId must not become a 500.
//
// Prod's ERROR log on 11-07 held these, each a Mongoose CastError on `_id`
// answered as a server error:
//   GET /api/pods/:podId/focus         (a literal ":podId" from a browser)
//   GET /api/integrations/connections  (also "tools", "connectors", "hosted-mcp")
// The runtime ack and the /api/users/:id handlers have their own tests.
//
// The models are real and there is no database: Mongoose casts the id before
// it needs a connection, so the CastError these routes threw in prod is the
// one they throw here.
const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6a0000000000000000000001' };
  req.userId = '6a0000000000000000000001';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn(async () => true) }));

const app = express();
app.use(express.json());
app.use('/api/pods', require('../../../routes/pods'));
app.use('/api/integrations', require('../../../routes/integrations'));

describe('F330: a non-ObjectId pod id answers 400, not 500', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  test.each([':podId', 'me', '6ad18344'])('GET /api/pods/%s/focus', async (id) => {
    const res = await request(app).get(`/api/pods/${id}/focus`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('PATCH /api/pods/:podId/focus', async () => {
    const res = await request(app)
      .patch('/api/pods/:podId/focus')
      .send({ expectedRevision: 0, focus: null });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test.each(['connections', 'tools', 'connectors', 'hosted-mcp', ':podId'])('GET /api/integrations/%s', async (id) => {
    const res = await request(app).get(`/api/integrations/${id}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pod_id');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
