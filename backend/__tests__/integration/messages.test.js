const request = require('supertest');
const express = require('express');
// eslint-disable-next-line no-unused-vars
const mongoose = require('mongoose');
const messageRoutes = require('../../routes/messages');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const PGMessage = require('../../models/pg/Message');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  setupPgDb,
  clearPgDb,
  closePgDb,
  generateTestToken,
  createTestUser,
  createTestPod,
} = require('../utils/testUtils');

// Mock PostgreSQL message model for testing
jest.mock('../../models/pg/Message');

describe('Message Routes Integration Tests', () => {
  let app;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    process.env.JWT_SECRET = 'test-jwt-secret';
    app.use('/api/messages', messageRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    // Setup mock implementations for PostgreSQL message model
    PGMessage.findByPodId = jest.fn();
    PGMessage.create = jest.fn();
    PGMessage.findById = jest.fn();
    PGMessage.delete = jest.fn();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
  });

  it('should get messages for a pod when user is a member', async () => {
    const user = await createTestUser(User);
    const pod = await createTestPod(Pod, user._id);
    const mockMessages = [{ id: 1, content: 'Hello', user_id: user._id.toString() }];
    
    PGMessage.findByPodId.mockResolvedValue(mockMessages);
    const token = generateTestToken(user._id);

    const response = await request(app)
      .get(`/api/messages/${pod._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0].content).toBe('Hello');
    expect(PGMessage.findByPodId).toHaveBeenCalledWith(pod._id.toString(), 50, undefined);
  });

  it('should return 401 if user is not a member of the pod', async () => {
    const creator = await createTestUser(User, { username: 'creator' });
    const pod = await createTestPod(Pod, creator._id);
    const outsider = await createTestUser(User, { username: 'outsider', email: 'out@example.com' });
    const token = generateTestToken(outsider._id);

    const response = await request(app)
      .get(`/api/messages/${pod._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(response.body.msg).toMatch(/Not authorized/);
  });

  it('should create a message successfully', async () => {
    const user = await createTestUser(User);
    const pod = await createTestPod(Pod, user._id);
    const mockMessage = { id: 1, content: 'Hi there', user_id: user._id.toString() };
    
    PGMessage.create.mockResolvedValue(mockMessage);
    const token = generateTestToken(user._id);

    const response = await request(app)
      .post(`/api/messages/${pod._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'Hi there' })
      .expect(200);

    expect(response.body.content).toBe('Hi there');
    expect(PGMessage.create).toHaveBeenCalledWith(
      pod._id.toString(), 
      user._id.toString(), 
      'Hi there', 
      'text'
    );
  });

  it('should return 400 when message text and attachments are missing', async () => {
    const user = await createTestUser(User);
    const pod = await createTestPod(Pod, user._id);
    const token = generateTestToken(user._id);

    const response = await request(app)
      .post(`/api/messages/${pod._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);

    expect(response.body.msg).toMatch(/required/);
  });
});
