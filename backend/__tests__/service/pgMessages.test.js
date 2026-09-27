const request = require('supertest');
const express = require('express');
const pgMessageRoutes = require('../../routes/pg-messages');
const { generateTestToken } = require('../utils/testUtils');

// #636 ban enforcement: auth middleware consults the Mongo User model per
// request; these tests use tokens for ids ('user1') with no backing row, so
// mock a live un-banned user to keep the middleware on its happy path.
jest.mock('../../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(() => ({
    select: () => ({ lean: async () => ({ banned: false }) }),
  })),
}));

jest.mock('../../models/Pod', () => ({ findById: jest.fn() }));

// Mock PG models
jest.mock('../../models/pg/Pod', () => ({
  findById: jest.fn(),
  addMember: jest.fn(),
}));

jest.mock('../../models/pg/Message', () => ({
  findByPodId: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../services/agentMentionService', () => {
  const { isAutoRoutedDmPod } = jest.requireActual('../../services/agentMentionService');
  return {
    enqueueMentions: jest.fn(async () => ({ enqueued: [], implicit: [], woken: [] })),
    enqueueDmEvent: jest.fn(),
    isAutoRoutedDmPod,
  };
});

const MongoPod = require('../../models/Pod');
const PGPod = require('../../models/pg/Pod');
const PGMessage = require('../../models/pg/Message');
const AgentMentionService = require('../../services/agentMentionService');

// TASK-162: Mongo `members` decides access, so an arm that expects 200 names
// the caller in the pod Mongo returns. There is no mirror reader left to keep in
// check — TASK-167 deleted `PGPod.isMember` — so a live PG row cannot reach the
// decision even in principle.
const podListing = (...memberIds) => {
  MongoPod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(memberIds === null || memberIds[0] === null
        ? null
        : { members: memberIds }),
    }),
  });
};

let app;

beforeAll(() => {
  app = express();
  app.use(express.json());
  process.env.JWT_SECRET = 'test-jwt-secret';
  app.use('/api/pg/messages', pgMessageRoutes);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('PostgreSQL Message Routes', () => {
  it('retrieves messages for a member of the pod, decided by Mongo membership', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    podListing('user1');
    PGMessage.findByPodId.mockResolvedValue([{ id: 1, content: 'Hello' }]);
    const token = generateTestToken('user1');

    const res = await request(app)
      .get('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(MongoPod.findById).toHaveBeenCalledWith('pod1');
    expect(res.body[0].content).toBe('Hello');
  });

  // TASK-162's witness at the route tier: the SURVIVOR. The `pod_members` row is
  // still present while Mongo membership is gone, so an arm that only leaves the
  // pod cannot see the defect — the survivor is what discriminates the read-time
  // check from a mirror-on-leave fix.
  it('refuses a post whose PG pod_members row survived a leave', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    podListing(); // Mongo membership is gone
    const token = generateTestToken('user1');

    const res = await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'still here?' })
      .expect(401);

    expect(res.body.msg).toMatch(/Not authorized/);
    expect(PGMessage.create).not.toHaveBeenCalled();
  });

  it('returns 401 if user is not a member', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    podListing();
    const token = generateTestToken('user1');

    const res = await request(app)
      .get('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.msg).toMatch(/Not authorized/);
  });

  it('creates a message successfully', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    podListing('user1');
    PGMessage.create.mockResolvedValue({ id: 1 });
    PGMessage.findById.mockResolvedValue({ id: 1, content: 'Hi there' });
    const token = generateTestToken('user1');

    const res = await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Hi there' })
      .expect(200);

    expect(PGMessage.create).toHaveBeenCalledWith('pod1', 'user1', 'Hi there');
    expect(res.body.content).toBe('Hi there');
    expect(res.body.agentDelivery).toEqual({
      enqueued: 0,
      implicit: [],
      agentsInPod: expect.any(Number),
      woken: 0,
    });
  });

  it('dispatches a regular PG post through the mention pipeline with its joined author', async () => {
    const message = {
      id: 'message-1',
      content: '@recorder capture this',
      userId: { _id: 'user1', username: 'sam' },
    };
    PGPod.findById.mockResolvedValue({ id: 'pod1', type: 'chat' });
    podListing('user1');
    PGMessage.create.mockResolvedValue({ id: message.id });
    PGMessage.findById.mockResolvedValue(message);
    const token = generateTestToken('user1');

    await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: message.content })
      .expect(200);

    expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith({
      podId: 'pod1', message, userId: 'user1', username: 'sam',
    });
    expect(AgentMentionService.enqueueDmEvent).not.toHaveBeenCalled();
  });

  it('delivers the persisted row when the post-write author join is unavailable', async () => {
    const persistedMessage = {
      id: 'message-join-miss',
      content: '@recorder capture this',
      username: 'sam',
    };
    PGPod.findById.mockResolvedValue({ id: 'pod1', type: 'chat' });
    podListing('user1');
    PGMessage.create.mockResolvedValue(persistedMessage);
    PGMessage.findById.mockResolvedValue(null);
    const token = generateTestToken('user1');

    const res = await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: persistedMessage.content })
      .expect(200);

    expect(res.body).toEqual({
      ...persistedMessage,
      agentDelivery: {
        enqueued: 0,
        implicit: [],
        agentsInPod: expect.any(Number),
        woken: 0,
      },
    });
    expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith({
      podId: 'pod1', message: persistedMessage, userId: 'user1', username: 'sam',
    });
  });

  it('dispatches a PG post in an agent DM through the DM pipeline', async () => {
    const message = {
      id: 'message-2',
      content: 'hello directly',
      userId: { _id: 'user1', username: 'sam' },
    };
    PGPod.findById.mockResolvedValue({ id: 'pod1', type: 'agent-room' });
    podListing('user1');
    PGMessage.create.mockResolvedValue({ id: message.id });
    PGMessage.findById.mockResolvedValue(message);
    const token = generateTestToken('user1');

    await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: message.content })
      .expect(200);

    expect(AgentMentionService.enqueueDmEvent).toHaveBeenCalledWith({
      podId: 'pod1', message, userId: 'user1', username: 'sam',
    });
    expect(AgentMentionService.enqueueMentions).not.toHaveBeenCalled();
  });

  it('rejects message creation for non-members', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    podListing();
    const token = generateTestToken('user1');

    const res = await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Denied' })
      .expect(401);

    expect(res.body.msg).toMatch(/Not authorized/);
  });
});
