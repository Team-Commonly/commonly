// F626: federation's catch-alls answer fixed text, not a driver's or a remote's
// message. The few messages PodLink throws on purpose still reach the person.
const request = require('supertest');
const express = require('express');

const DRIVER_TEXT = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'u1';
  req.user = { id: 'u1' };
  next();
});
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ _id: 'p1', members: [{ userId: 'u1', role: 'admin' }] }),
  })),
}));
jest.mock('../../../models/PodLink', () => ({ requestLink: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/federationService', () => ({ queryLinkedPod: jest.fn() }));

const PodLink = require('../../../models/PodLink');
const FederationService = require('../../../services/federationService');
const router = require('../../../routes/federation');

const app = express();
app.use(express.json());
app.use('/api/federation', router);

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const expectFixed = (res, text, label) => {
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: text });
  expect(res.text).not.toContain('db.internal.example');
  expect(res.text).not.toContain('secret_table');
  const logs = JSON.stringify(errorSpy.mock.calls);
  expect(logs).toContain(label);
  expect(logs).toContain('db.internal.example');
};

describe('federation 500s', () => {
  const link = { sourcePodId: 'p1', _id: { toString: () => 'l1' }, status: 'pending' };
  const requestBody = { sourcePodId: 'p1', targetPodId: 'p2', scopes: ['read'] };

  it('request: a driver failure answers fixed text and logs the cause', async () => {
    PodLink.requestLink.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post('/api/federation/links').send(requestBody);
    expectFixed(res, 'Failed to request link', 'Error requesting link:');
  });

  it('query: the scope and query-type refusals pass through by prefix, a driver error does not', async () => {
    const body = { sourcePodId: 'p1', targetPodId: 'p2', queryType: 'summary' };
    FederationService.queryLinkedPod.mockRejectedValueOnce(new Error('Query exceeds granted scopes: summary:read'));
    let res = await request(app).post('/api/federation/query').send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Query exceeds granted scopes: summary:read' });
    FederationService.queryLinkedPod.mockRejectedValueOnce(new Error('Unknown query type: bogus'));
    res = await request(app).post('/api/federation/query').send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown query type: bogus' });
    FederationService.queryLinkedPod.mockRejectedValueOnce(new Error(DRIVER_TEXT));
    res = await request(app).post('/api/federation/query').send(body);
    expectFixed(res, 'Failed to query linked pod', 'Error querying linked pod:');
  });

  it('request: a message PodLink threw on purpose still passes through', async () => {
    PodLink.requestLink.mockRejectedValue(new Error('Link already exists'));
    const res = await request(app).post('/api/federation/links').send(requestBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Link already exists' });
  });

  it('approve: a driver failure answers fixed text', async () => {
    PodLink.findById.mockResolvedValue({ ...link, approve: jest.fn().mockRejectedValue(new Error(DRIVER_TEXT)) });
    expectFixed(await request(app).post('/api/federation/links/l1/approve'), 'Failed to approve link', 'Error approving link:');
  });

  it('revoke: a driver failure answers fixed text', async () => {
    PodLink.findById.mockResolvedValue({ ...link, revoke: jest.fn().mockRejectedValue(new Error(DRIVER_TEXT)) });
    expectFixed(await request(app).post('/api/federation/links/l1/revoke'), 'Failed to revoke link', 'Error revoking link:');
  });

  it('query: a remote failure answers fixed text', async () => {
    FederationService.queryLinkedPod.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post('/api/federation/query')
      .send({ sourcePodId: 'p1', targetPodId: 'p2', queryType: 'summary' });
    expectFixed(res, 'Failed to query linked pod', 'Error querying linked pod:');
  });

  it('a 404 we wrote still passes through', async () => {
    PodLink.findById.mockResolvedValue(null);
    const res = await request(app).post('/api/federation/links/l1/approve');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Link not found' });
  });
});
