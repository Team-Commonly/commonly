const request = require('supertest');
const express = require('express');
const pgMessageRoutes = require('../../routes/pg-messages');
const { generateTestToken } = require('../utils/testUtils');

// Mock PG models
jest.mock('../../models/pg/Pod', () => ({
  findById: jest.fn(),
  isMember: jest.fn(),
  addMember: jest.fn(),
}));

jest.mock('../../models/pg/Message', () => ({
  findByPodId: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
}));

const PGPod = require('../../models/pg/Pod');
const PGMessage = require('../../models/pg/Message');

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
  it('retrieves messages when user is member', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    PGPod.isMember.mockResolvedValue(true);
    PGMessage.findByPodId.mockResolvedValue([{ id: 1, content: 'Hello' }]);
    const token = generateTestToken('user1');

    const res = await request(app)
      .get('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(PGPod.isMember).toHaveBeenCalledWith('pod1', 'user1');
    expect(res.body[0].content).toBe('Hello');
  });

  it('returns 401 if user is not a member', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    PGPod.isMember.mockResolvedValue(false);
    const token = generateTestToken('user1');

    const res = await request(app)
      .get('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.msg).toMatch(/Not authorized/);
  });

  it('creates a message successfully', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    PGPod.isMember.mockResolvedValue(true);
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
  });

  it('rejects message creation for non-members', async () => {
    PGPod.findById.mockResolvedValue({ id: 'pod1' });
    PGPod.isMember.mockResolvedValue(false);
    const token = generateTestToken('user1');

    const res = await request(app)
      .post('/api/pg/messages/pod1')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Denied' })
      .expect(401);

    expect(res.body.msg).toMatch(/Not authorized/);
  });
});
