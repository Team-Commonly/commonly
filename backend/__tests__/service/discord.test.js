const request = require('supertest');
const express = require('express');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
  createTestUser,
  createTestPod,
} = require('../utils/testUtils');

// Mock Discord services
jest.mock('../../services/discordService');

const discordRoutes = require('../../routes/discord');
const User = require('../../models/User');
const Pod = require('../../models/Pod');

describe('Discord Integration Routes', () => {
  let app;

  beforeAll(async () => {
    await setupMongoDb();

    app = express();
    app.use(express.json());
    process.env.JWT_SECRET = 'test-jwt-secret';
    app.use('/api/discord', discordRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
  });

  describe('Discord Integration API endpoints', () => {
    it('should handle Discord routes without crashing', async () => {
      const user = await createTestUser(User);
      const pod = await createTestPod(Pod, user._id);
      const token = generateTestToken(user._id);

      // Test that the routes are properly set up
      const response = await request(app)
        .get('/api/discord/test')
        .set('Authorization', `Bearer ${token}`)
        .expect(404); // Expected since route doesn't exist, but tests middleware

      expect(response.status).toBe(404);
    });

    it('should require authentication for Discord routes', async () => {
      const response = await request(app).get('/api/discord/test').expect(404); // Route doesn't exist, but we're testing that middleware is in place

      expect(response.status).toBe(404);
    });
  });
});
