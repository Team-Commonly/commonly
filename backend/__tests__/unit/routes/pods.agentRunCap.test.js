/**
 * PATCH /api/pods/:id/agent-run-cap: a pod's own consecutive-run cap for its
 * agents. The pod creator or a global admin sets it; 3..50 or null, never off.
 */

const express = require('express');
const request = require('supertest');

// The route's limiter would 429 partway through; every request shares one IP.
jest.mock('express-rate-limit', () => {
  const factory = () => (_req, _res, next) => next();
  factory.ipKeyGenerator = (ip) => ip;
  return { __esModule: true, default: factory, ipKeyGenerator: factory.ipKeyGenerator };
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = req.headers['x-test-user'] || 'owner-1';
  if (req.headers['x-test-bot']) req.botCaller = { username: 'builder-bot', botMetadata: {} };
  next();
});

const podSave = jest.fn();
const mockPod = { value: null };

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => Promise.resolve(mockPod.value)),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({
      lean: jest.fn(() => Promise.resolve({ role: 'user' })),
    })),
  })),
}));

jest.mock('../../../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve()) }));

jest.mock('../../../controllers/podController', () => ({
  updatePodParent: jest.fn(),
  getAllPods: (_q, res) => res.json([]),
  getPodsByType: (_q, res) => res.json([]),
  getPodById: (_q, res) => res.json({}),
  createPod: (_q, res) => res.json({}),
  joinPod: (_q, res) => res.json({}),
  leavePod: (_q, res) => res.json({}),
  removeMember: (_q, res) => res.json({}),
  deletePod: (_q, res) => res.json({}),
}));

const AuditLog = require('../../../models/AuditLog');
const User = require('../../../models/User');

const app = express();
app.use(express.json());
app.use('/api/pods', require('../../../routes/pods'));

const pod = (over = {}) => ({
  _id: 'pod-1', type: 'chat', createdBy: 'owner-1', save: podSave, ...over,
});
const setCap = (agentRunCap, user = 'owner-1') => request(app)
  .patch('/api/pods/pod-1/agent-run-cap')
  .set('x-test-user', user)
  .send({ agentRunCap });

describe('PATCH /api/pods/:id/agent-run-cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    podSave.mockResolvedValue(undefined);
    mockPod.value = pod();
  });

  test('the creator sets the cap, and the change is audited', async () => {
    const res = await setCap(20);
    expect(res.status).toBe(200);
    expect(res.body.agentRunCap).toBe(20);
    expect(mockPod.value.agentRunCap).toBe(20);
    expect(podSave).toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pod.agent_run_cap_changed', detail: 'agentRunCap=20 previous=default',
    }));
  });

  test('null clears it back to the instance default', async () => {
    mockPod.value = pod({ agentRunCap: 20 });
    const res = await setCap(null);
    expect(res.status).toBe(200);
    expect(res.body.agentRunCap).toBeNull();
    expect(mockPod.value.agentRunCap).toBeUndefined();
  });

  test.each([0, 2, 51, 2.5, '20', undefined])('refuses %p: never off, and within 3..50', async (value) => {
    const res = await setCap(value);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_agent_run_cap');
    expect(podSave).not.toHaveBeenCalled();
  });

  test('a member who is not the creator is refused', async () => {
    const res = await setCap(20, 'member-2');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_pod_owner');
    expect(podSave).not.toHaveBeenCalled();
  });

  test('an agent is refused even on a pod it created', async () => {
    const res = await request(app)
      .patch('/api/pods/pod-1/agent-run-cap')
      .set('x-test-user', 'owner-1')
      .set('x-test-bot', '1')
      .send({ agentRunCap: 50 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_caller_refused');
    expect(podSave).not.toHaveBeenCalled();
  });

  test('a global admin may set it', async () => {
    User.findById.mockImplementationOnce(() => ({
      select: () => ({ lean: () => Promise.resolve({ role: 'admin' }) }),
    }));
    expect((await setCap(10, 'admin-9')).status).toBe(200);
  });

  test('a DM pod is not configurable', async () => {
    mockPod.value = pod({ type: 'agent-room' });
    const res = await setCap(20);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pod_type_not_configurable');
  });

  test('an unknown pod is a 404', async () => {
    mockPod.value = null;
    expect((await setCap(20)).status).toBe(404);
  });
});
