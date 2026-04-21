const request = require('supertest');
const express = require('express');
// eslint-disable-next-line no-unused-vars
const mongoose = require('mongoose');
const userRoutes = require('../../routes/users');
const User = require('../../models/User');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
} = require('../utils/testUtils');

describe('User Routes Integration Tests', () => {
  let app;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    process.env.JWT_SECRET = 'test-jwt-secret';
    app.use('/api/users', userRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('should get current profile with valid token', async () => {
    const user = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'Password123!',
    });
    await user.save();
    const token = generateTestToken(user._id);

    const res = await request(app)
      .get('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.username).toBe('testuser');
    expect(res.body.email).toBe('test@example.com');
  });

  it('should return 401 when token is missing', async () => {
    await request(app).get('/api/users/profile').expect(401);
  });

  it('should update profile picture', async () => {
    const user = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'Password123!',
    });
    await user.save();
    const token = generateTestToken(user._id);

    const res = await request(app)
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ profilePicture: 'newpic.jpg' })
      .expect(200);

    expect(res.body.profilePicture).toBe('newpic.jpg');

    const updated = await User.findById(user._id);
    expect(updated.profilePicture).toBe('newpic.jpg');
  });
});
