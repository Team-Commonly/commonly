// F626: invite routes answer an unexpected failure with fixed text. The cause
// goes to the server log; a refusal we wrote still reaches the person.
const request = require('supertest');
const express = require('express');

const DRIVER_TEXT = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});
const mockFindOne = jest.fn();
jest.mock('../../../models/PodInvite', () => ({
  PodInvite: { find: jest.fn(), findOne: (...a) => mockFindOne(...a), create: jest.fn() },
}));
jest.mock('../../../models/Pod');
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/outsiderGrantAgentJoinPolicy', () => ({ assertInstalledAgentMayJoinPod: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({ DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']) }));

const Pod = require('../../../models/Pod');
const routes = require('../../../routes/podInvites');

const POD_ID = '507f1f77bcf86cd799439011';
const TOKEN = 'a'.repeat(32);
const app = express();
app.use(express.json());
app.use('/api', routes);

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const expectFixed = (res, msg, label) => {
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ msg });
  expect(res.text).not.toContain('db.internal.example');
  expect(res.text).not.toContain('secret_table');
  const logs = JSON.stringify(errorSpy.mock.calls);
  expect(logs).toContain(label);
  expect(logs).toContain('db.internal.example');
};

describe('pod invite 500s', () => {
  it('create', async () => {
    Pod.findById.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post(`/api/pods/${POD_ID}/invites`).send({});
    expectFixed(res, 'Failed to create invite', 'Create invite failed:');
  });

  it('list', async () => {
    Pod.findById.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).get(`/api/pods/${POD_ID}/invites`);
    expectFixed(res, 'Failed to list invites', 'List invites failed:');
  });

  it('revoke', async () => {
    mockFindOne.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).delete(`/api/invites/${TOKEN}`);
    expectFixed(res, 'Failed to revoke invite', 'Revoke invite failed:');
  });

  it('resolve', async () => {
    mockFindOne.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).get(`/api/invites/${TOKEN}`);
    expectFixed(res, 'Failed to resolve invite', 'Resolve invite failed:');
  });

  it('redeem', async () => {
    mockFindOne.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post(`/api/invites/${TOKEN}/redeem`);
    expectFixed(res, 'Failed to redeem invite', 'Redeem invite failed:');
  });

  it('a refusal we wrote still passes through', async () => {
    Pod.findById.mockResolvedValue({ _id: POD_ID, type: 'chat', createdBy: 'owner', members: ['someone-else'] });
    const res = await request(app).get(`/api/pods/${POD_ID}/invites`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ msg: 'Only pod members can manage invites' });
  });
});
