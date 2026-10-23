const request = require('supertest');
const express = require('express');
const User = require('../../models/User');
const githubRoutes = require('../../routes/github');
const GitHubAppService = require('../../services/githubAppService');
const auth = require('../../middleware/auth');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken,
} = require('../utils/testUtils');

// Drive the real GitHub route through the real auth middleware and a real
// projected Mongo row. A route test that replaces auth with a fabricated
// req.user cannot catch browser JWTs losing role or other identity fields.
describe('GitHub admin route with a browser JWT', () => {
  let app;
  let seq = 0;

  beforeAll(async () => {
    await setupMongoDb();
    process.env.JWT_SECRET = 'github-browser-jwt-test-secret';
    app = express();
    app.use('/api/github', githubRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
  });

  const createUser = async (role, overrides = {}) => {
    seq += 1;
    return User.create({
      username: `github-jwt-${seq}`,
      email: `github-jwt-${seq}@example.com`,
      password: 'hashed-pass',
      role,
      ...overrides,
    });
  };

  it('admits a real admin browser session and denies a non-admin', async () => {
    jest.spyOn(GitHubAppService, 'isPatConfigured').mockReturnValue(true);
    const admin = await createUser('admin');
    const member = await createUser('user');

    const adminResponse = await request(app)
      .get('/api/github/status')
      .set('Authorization', `Bearer ${generateTestToken(String(admin._id))}`);
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.body).toEqual({ mode: 'pat', configured: true });

    const memberResponse = await request(app)
      .get('/api/github/status')
      .set('Authorization', `Bearer ${generateTestToken(String(member._id))}`);
    expect(memberResponse.status).toBe(403);
    expect(memberResponse.body).toEqual({ message: 'Admin only' });
  });

  it('carries username, email and role from the live row', async () => {
    const admin = await createUser('admin');
    const token = generateTestToken(String(admin._id));
    const req = { header: (name) => (name === 'Authorization' ? `Bearer ${token}` : undefined) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await auth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual({
      id: String(admin._id),
      username: admin.username,
      email: admin.email,
      role: 'admin',
    });
  });

  it('still refuses an agent row before reaching the GitHub route', async () => {
    const bot = await createUser('admin', { isBot: true });

    const response = await request(app)
      .get('/api/github/status')
      .set('Authorization', `Bearer ${generateTestToken(String(bot._id))}`);
    expect(response.status).toBe(403);
    expect(response.body.msg).toMatch(/Agent accounts authenticate/);
  });
});
