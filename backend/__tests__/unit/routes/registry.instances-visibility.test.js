// GET /api/registry/agents/:name/instances and /instances/:instanceId list
// only the pods the caller can see, the same rule the sibling
// /agents/:name/installations applies (userHasPodAccess: member or creator;
// admins see the same list on a listing surface).
const request = require('supertest');
const express = require('express');

let mockCallerId = 'user-1';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: mockCallerId };
  req.userId = mockCallerId;
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: { find: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));

jest.mock('../../../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const PODS = [
  { _id: 'pod-mine', name: 'My Pod', type: 'chat', members: ['user-1', 'bot-1'], createdBy: 'user-1' },
  { _id: 'pod-private', name: 'Secret Pod', type: 'chat', members: ['user-2', 'bot-1'], createdBy: 'user-2' },
  { _id: 'pod-dm', name: 'DM with agent', type: 'agent-room', members: ['user-2', 'bot-1'], createdBy: 'user-2' },
  { _id: 'pod-a2a', name: 'Agent DM', type: 'agent-dm', members: ['bot-1', 'bot-2'], createdBy: 'bot-1' },
];

const INSTALLS = [
  { podId: 'pod-mine', agentName: 'nib', instanceId: 'default', displayName: 'Nib', status: 'active' },
  { podId: 'pod-private', agentName: 'nib', instanceId: 'default', displayName: 'Nib', status: 'active' },
  { podId: 'pod-dm', agentName: 'nib', instanceId: 'default', displayName: 'Nib', status: 'active' },
  { podId: 'pod-a2a', agentName: 'nib', instanceId: 'default', displayName: 'Nib', status: 'active' },
  { podId: 'pod-private', agentName: 'nib', instanceId: 'other', displayName: 'Nib Other', status: 'active' },
];

const selectLean = (rows) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCallerId = 'user-1';
  AgentInstallation.find.mockImplementation((query) => ({
    lean: jest.fn().mockResolvedValue(INSTALLS.filter((i) => (
      i.agentName === query.agentName
      && (query.instanceId === undefined || i.instanceId === query.instanceId)
    ))),
  }));
  Pod.find.mockImplementation((query) => {
    const ids = (query?._id?.$in || []).map(String);
    return selectLean(PODS.filter((p) => ids.includes(p._id)));
  });
  User.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({ username: 'nib', agentRuntimeTokens: [{ tokenHash: 'h' }] }),
  });
  User.findById.mockReturnValue(selectLean({ role: 'user' }));
});

const allPodIds = (body) => JSON.stringify(body);

describe('GET /api/registry/agents/:name/instances', () => {
  it('lists only pods the caller is a member of', async () => {
    const res = await request(app).get('/api/registry/agents/nib/instances');
    expect(res.status).toBe(200);
    expect(res.body.instances).toEqual([
      { instanceId: 'default', displayName: 'Nib', pods: [{ podId: 'pod-mine', podName: 'My Pod' }] },
    ]);
    const text = allPodIds(res.body);
    ['pod-private', 'Secret Pod', 'pod-dm', 'DM with agent', 'pod-a2a', 'Agent DM'].forEach((s) => {
      expect(text).not.toContain(s);
    });
  });

  it('drops an instance installed only in pods the caller cannot see', async () => {
    const res = await request(app).get('/api/registry/agents/nib/instances');
    expect(res.body.instances.map((i) => i.instanceId)).not.toContain('other');
  });

  it('shows a member their own private pod and DM', async () => {
    mockCallerId = 'user-2';
    const res = await request(app).get('/api/registry/agents/nib/instances');
    const byId = Object.fromEntries(res.body.instances.map((i) => [i.instanceId, i.pods]));
    expect(byId.default).toEqual([
      { podId: 'pod-private', podName: 'Secret Pod' },
      { podId: 'pod-dm', podName: 'DM with agent' },
    ]);
    expect(byId.other).toEqual([{ podId: 'pod-private', podName: 'Secret Pod' }]);
  });

  it('lists an admin only the pods they are in', async () => {
    mockCallerId = 'admin-1';
    User.findById.mockReturnValue(selectLean({ role: 'admin' }));
    const res = await request(app).get('/api/registry/agents/nib/instances');
    expect(res.body.instances).toEqual([]);
  });
});

describe('GET /api/registry/agents/:name/instances/:instanceId', () => {
  it('lists only visible installations, with runtime details', async () => {
    const res = await request(app).get('/api/registry/agents/nib/instances/default');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.installations.map((i) => i.podId)).toEqual(['pod-mine']);
    expect(res.body.installations[0].podName).toBe('My Pod');
    expect(res.body.hasRuntimeToken).toBe(true);
    expect(res.body.agentUsername).toBe('nib');
    const text = allPodIds(res.body);
    ['pod-private', 'Secret Pod', 'pod-dm', 'DM with agent', 'pod-a2a', 'Agent DM'].forEach((s) => {
      expect(text).not.toContain(s);
    });
  });

  it('hides pods and runtime details for an instance only in pods the caller cannot see', async () => {
    const res = await request(app).get('/api/registry/agents/nib/instances/other');
    expect(res.status).toBe(200);
    expect(res.body.installations).toEqual([]);
    expect(res.body).not.toHaveProperty('hasRuntimeToken');
    expect(res.body).not.toHaveProperty('agentUsername');
    expect(allPodIds(res.body)).not.toContain('pod-private');
    expect(allPodIds(res.body)).not.toContain('Secret Pod');
  });

  it('shows a member their own pods', async () => {
    mockCallerId = 'user-2';
    const res = await request(app).get('/api/registry/agents/nib/instances/other');
    expect(res.body.installations.map((i) => i.podId)).toEqual(['pod-private']);
    expect(res.body.hasRuntimeToken).toBe(true);
    expect(res.body.agentUsername).toBe('nib');
  });

  it('shows an admin only the installations in pods they are in', async () => {
    mockCallerId = 'admin-1';
    User.findById.mockReturnValue(selectLean({ role: 'admin' }));
    const res = await request(app).get('/api/registry/agents/nib/instances/default');
    expect(res.body.installations).toEqual([]);
    expect(res.body).not.toHaveProperty('hasRuntimeToken');
  });

  it('still answers exists:false for an unknown instance', async () => {
    const res = await request(app).get('/api/registry/agents/nib/instances/nope');
    expect(res.body).toEqual({ exists: false });
  });
});
