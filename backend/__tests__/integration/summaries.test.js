const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Summary = require('../../models/Summary');
const Post = require('../../models/Post');
const summaryRoutes = require('../../routes/summaries');
const authMiddleware = require('../../middleware/auth');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

describe('Summaries Routes Integration Tests', () => {
  let app;
  let authToken;
  let testUser;
  const testPods = {};

  beforeAll(async () => {
    await setupMongoDb();

    // Create a minimal Express app for testing
    app = express();
    app.use(express.json());

    // Set environment variables for testing
    process.env.JWT_SECRET = 'test-jwt-secret';

    // Register routes with auth middleware
    app.use('/api/summaries', authMiddleware, summaryRoutes);

    // Create test user
    testUser = new User({
      username: 'summaryuser',
      email: 'summary@test.com',
      password: 'hashedpassword',
      isVerified: true,
    });
    await testUser.save();

    // Generate auth token
    authToken = jwt.sign(
      { user: { id: testUser._id } },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );

    // Create test pods
    const chatPod = new Pod({
      name: 'Test Chat Room',
      type: 'chat',
      createdBy: testUser._id,
      members: [testUser._id],
    });
    await chatPod.save();
    testPods.chat = chatPod._id;

    const studyPod = new Pod({
      name: 'Test Study Group',
      type: 'study',
      createdBy: testUser._id,
      members: [testUser._id],
    });
    await studyPod.save();
    testPods.study = studyPod._id;

    const gamePod = new Pod({
      name: 'Test Game Room',
      type: 'games',
      createdBy: testUser._id,
      members: [testUser._id],
    });
    await gamePod.save();
    testPods.games = gamePod._id;

    // Create test posts for the all-posts summary
    await Post.create({
      userId: testUser._id,
      content: 'This is a test post about technology and innovation.',
      tags: ['technology', 'innovation'],
      createdAt: new Date(),
    });

    await Post.create({
      userId: testUser._id,
      content: 'Another post discussing community and lifestyle topics.',
      tags: ['lifestyle', 'community'],
      createdAt: new Date(),
    });

    await Post.create({
      userId: testUser._id,
      content: 'A general discussion post about various topics.',
      tags: ['discussion'],
      createdAt: new Date(),
    });

    // Create test summaries
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // Chat room summaries
    await Summary.create({
      type: 'chats',
      podId: testPods.chat,
      title: 'Active Chat Discussion',
      content:
        'Users discussed various topics including technology and current events.',
      timeRange: { start: oneHourAgo, end: now },
      metadata: {
        totalItems: 15,
        topTags: [],
        topUsers: ['user1', 'user2'],
        podName: 'Test Chat Room',
      },
    });

    await Summary.create({
      type: 'chats',
      podId: testPods.study,
      title: 'Study Session Summary',
      content:
        'Students collaborated on assignments and shared study resources.',
      timeRange: { start: oneHourAgo, end: now },
      metadata: {
        totalItems: 8,
        topTags: [],
        topUsers: ['student1', 'student2'],
        podName: 'Test Study Group',
      },
    });

    await Summary.create({
      type: 'chats',
      podId: testPods.games,
      title: 'Gaming Session',
      content: 'Players discussed strategies and organized gaming sessions.',
      timeRange: { start: oneHourAgo, end: now },
      metadata: {
        totalItems: 22,
        topTags: [],
        topUsers: ['gamer1', 'gamer2'],
        podName: 'Test Game Room',
      },
    });

    // Overall summaries (without podId)
    await Summary.create({
      type: 'posts',
      title: 'Community Posts Overview',
      content:
        'The community shared various posts about technology, lifestyle, and discussions.',
      timeRange: { start: oneHourAgo, end: now },
      metadata: {
        totalItems: 25,
        topTags: ['technology', 'lifestyle', 'discussion'],
        topUsers: ['poster1', 'poster2'],
      },
    });

    await Summary.create({
      type: 'chats',
      title: 'Overall Chat Activity',
      content: 'Chat rooms were active with discussions across various topics.',
      timeRange: { start: oneHourAgo, end: now },
      metadata: {
        totalItems: 45,
        topTags: ['Test Chat Room', 'Test Study Group'],
        topUsers: ['user1', 'student1'],
      },
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    // Don't clear all data, just clean up any test-specific data if needed
    jest.clearAllMocks();
  });

  describe('GET /api/summaries/latest', () => {
    test('should get latest summaries of each type', async () => {
      const response = await request(app)
        .get('/api/summaries/latest')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('posts');
      expect(response.body).toHaveProperty('chats');
      expect(response.body.posts).toHaveProperty(
        'title',
        'Community Posts Overview',
      );
      expect(response.body.chats).toHaveProperty(
        'title',
        'Overall Chat Activity',
      );
    });

    test('should return 401 without authentication', async () => {
      const response = await request(app).get('/api/summaries/latest');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/summaries/chat-rooms', () => {
    test('should get recent chat room summaries', async () => {
      const response = await request(app)
        .get('/api/summaries/chat-rooms')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);

      const chatSummary = response.body.find(
        (s) => s.metadata?.podName === 'Test Chat Room',
      );
      expect(chatSummary).toBeDefined();
      expect(chatSummary.title).toBe('Active Chat Discussion');
      expect(chatSummary.metadata.totalItems).toBe(15);
    });

    test('should respect limit parameter', async () => {
      const response = await request(app)
        .get('/api/summaries/chat-rooms?limit=1')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.length).toBeLessThanOrEqual(1);
    });
  });

  describe('GET /api/summaries/study-rooms', () => {
    test('should get recent study room summaries', async () => {
      const response = await request(app)
        .get('/api/summaries/study-rooms')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);

      const studySummary = response.body.find(
        (s) => s.metadata?.podName === 'Test Study Group',
      );
      expect(studySummary).toBeDefined();
      expect(studySummary.title).toBe('Study Session Summary');
      expect(studySummary.metadata.totalItems).toBe(8);
    });
  });

  describe('GET /api/summaries/game-rooms', () => {
    test('should get recent game room summaries', async () => {
      const response = await request(app)
        .get('/api/summaries/game-rooms')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);

      const gameSummary = response.body.find(
        (s) => s.metadata?.podName === 'Test Game Room',
      );
      expect(gameSummary).toBeDefined();
      expect(gameSummary.title).toBe('Gaming Session');
      expect(gameSummary.metadata.totalItems).toBe(22);
    });
  });

  describe('GET /api/summaries/all-posts', () => {
    test('should get all posts summary', async () => {
      const response = await request(app)
        .get('/api/summaries/all-posts')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('title');
      expect(response.body.title).toContain('Community Overview');
      expect(response.body.title).toContain('3 posts'); // We created 3 test posts
      expect(response.body).toHaveProperty('content');
      expect(response.body.metadata.totalItems).toBe(3);
      // Since Gemini API is not available in tests, the fallback won't have tags
      expect(response.body.metadata).toHaveProperty('topTags');
      expect(response.body.metadata).toHaveProperty('topUsers');
      expect(response.body.metadata.timeRange).toBe('All time');
    });
  });

  describe('GET /api/summaries/pod/:podId', () => {
    test('should get latest summary for specific pod', async () => {
      const response = await request(app)
        .get(`/api/summaries/pod/${testPods.chat}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Active Chat Discussion');
      expect(response.body.podId).toBe(testPods.chat.toString());
    });

    test('should return null for pod with no summaries', async () => {
      const nonExistentPodId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .get(`/api/summaries/pod/${nonExistentPodId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
    });
  });

  describe('GET /api/summaries/pods', () => {
    test('should get summaries for multiple pods', async () => {
      const podIds = `${testPods.chat},${testPods.study}`;
      const response = await request(app)
        .get(`/api/summaries/pods?podIds=${podIds}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(typeof response.body).toBe('object');
      expect(response.body[testPods.chat.toString()]).toBeDefined();
      expect(response.body[testPods.study.toString()]).toBeDefined();
    });

    test('should return 400 when podIds parameter is missing', async () => {
      const response = await request(app)
        .get('/api/summaries/pods')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('podIds parameter is required');
    });
  });

  describe('Error handling', () => {
    test('should handle server errors gracefully', async () => {
      // Test with malformed pod ID
      const response = await request(app)
        .get('/api/summaries/pod/invalid-id')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to fetch pod summary');
    });
  });
});
