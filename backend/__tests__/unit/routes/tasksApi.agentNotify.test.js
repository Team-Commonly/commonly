/**
 * Board write -> agent fan-out wiring (ADR-024 D1).
 *
 * `notifyPodAgents` itself is covered in the service test. What is covered HERE
 * is the wiring, which is where this change can fail invisibly: a board write
 * that reaches Socket.io and skips the fan-out looks completely healthy from
 * the outside — the request 200s, the Kanban updates, the human sees the board
 * move, and only the agents learn nothing. That is the exact asymmetry D1
 * exists to remove, so it gets an assertion rather than an assumption.
 *
 * Also pinned: the actor shape. `isAgent` is what prices a wake against the
 * cascade cap, and it is derived from the auth shape (`agentRuntimeAuth` sets
 * `req.agentUser`, never `req.user`). Get it wrong for an agent and board
 * churn stops terminating.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'u1';
  req.user = { id: 'u1', _id: 'u1' };
  next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-9' };
  next();
});

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({
      type: 'chat',
      members: [{ toString: () => 'u1' }, { toString: () => 'bot-9' }],
    }),
  })),
}));

const mockFindOneAndUpdate = jest.fn();
jest.mock('../../../models/Task', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  findOne: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ username: 'alice' }) })),
  })),
}));

jest.mock('../../../services/githubAppService', () => ({
  isPatConfigured: jest.fn(() => false),
}));

const mockNotifyPodAgents = jest.fn();
jest.mock('../../../services/taskEventService', () => ({
  emitTaskUpdated: jest.fn(),
  notifyPodAgents: (...args) => mockNotifyPodAgents(...args),
}));

const tasksApi = require('../../../routes/tasksApi');

const app = express();
app.use(express.json());
app.use('/api/v1/tasks', tasksApi);

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const patch = (token) => {
  const req = request(app).patch(`/api/v1/tasks/${POD_ID}/TASK-001`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ status: 'in_progress' });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOneAndUpdate.mockResolvedValue({ taskId: 'TASK-001', status: 'claimed' });
  mockNotifyPodAgents.mockResolvedValue(undefined);
});

describe('board writes reach the pod agents', () => {
  it('fans a human PATCH out to the agents, marked as a human edit', async () => {
    const res = await patch();

    expect(res.status).toBe(200);
    expect(mockNotifyPodAgents).toHaveBeenCalledTimes(1);
    const [podId, , kind, actor] = mockNotifyPodAgents.mock.calls[0];
    expect(podId).toBe(POD_ID);
    expect(kind).toBe('updated');
    // A human edit resets the cascade streak; mislabelling it as an agent edit
    // would let a busy board starve the very seats it is trying to feed.
    expect(actor).toEqual({ userId: 'u1', isAgent: false });
  });

  it('marks an AGENT PATCH as an agent edit, so board churn terminates', async () => {
    const res = await patch('cm_agent_test');

    expect(res.status).toBe(200);
    const [, , , actor] = mockNotifyPodAgents.mock.calls[0];
    // agentRuntimeAuth sets req.agentUser and never req.user — deriving this
    // from the wrong field is how an unbounded wake loop gets built.
    expect(actor.isAgent).toBe(true);
    expect(actor.userId).toBe('bot-9');
  });

  it('still answers the board write when the fan-out rejects', async () => {
    mockNotifyPodAgents.mockRejectedValue(new Error('event store down'));

    const res = await patch();

    // The board is a human-facing surface; it must not inherit the agent
    // layer's availability.
    expect(res.status).toBe(200);
  });

  it('still answers the board write when the fan-out throws synchronously', async () => {
    // The failure an unhandled-rejection guard alone does NOT catch, and the
    // one that actually occurred: a partial mock / renamed export makes the
    // call itself throw before any promise exists.
    mockNotifyPodAgents.mockImplementation(() => { throw new Error('not a function'); });

    const res = await patch();

    expect(res.status).toBe(200);
  });
});
