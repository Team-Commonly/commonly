const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../../models/User');
const authRoutes = require('../../routes/auth');
const { setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken } = require('../utils/testUtils');

// Mock SendGrid to prevent actual emails from being sent
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue(true)
}));

describe('Auth Routes Integration Tests', () => {
  let app;

  // Setup and teardown for MongoDB and Express app
  beforeAll(async () => {
    await setupMongoDb();

    // Create a minimal Express app for testing
    app = express();
    app.use(express.json());
    
    // Set environment variables for testing
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.SENDGRID_FROM_EMAIL = 'test@example.com';
    
    // Register auth routes
    app.use('/api/auth', authRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body.message).toContain('User registered successfully');

      // Verify user was created in the database
      const user = await User.findOne({ email: userData.email });
      expect(user).toBeTruthy();
      expect(user.username).toBe(userData.username);
      expect(user.verified).toBe(false);
    });

    it('should return 400 for existing user', async () => {
      // Create a user first
      const existingUser = new User({
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'Password123!'
      });
      await existingUser.save();

      // Try to register with the same email
      const userData = {
        username: 'newuser',
        email: 'existing@example.com',
        password: 'Password123!'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toContain('User already exists');
    });

    it('should validate required fields', async () => {
      // Missing username
      const missingUsername = {
        email: 'test@example.com',
        password: 'Password123!'
      };

      await request(app)
        .post('/api/auth/register')
        .send(missingUsername)
        .expect(500); // Mongoose validation error

      // Missing email
      const missingEmail = {
        username: 'testuser',
        password: 'Password123!'
      };

      await request(app)
        .post('/api/auth/register')
        .send(missingEmail)
        .expect(500); // Mongoose validation error

      // Missing password
      const missingPassword = {
        username: 'testuser',
        email: 'test@example.com'
      };

      await request(app)
        .post('/api/auth/register')
        .send(missingPassword)
        .expect(500); // Mongoose validation error
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login a verified user successfully', async () => {
      // Create a verified user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: true
      });
      await user.save();

      const loginData = {
        email: 'test@example.com',
        password: 'Password123!'
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(200);

      expect(response.body.token).toBeDefined();
      expect(response.body.verified).toBe(true);
    });

    it('should not login an unverified user', async () => {
      // Create an unverified user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: false
      });
      await user.save();

      const loginData = {
        email: 'test@example.com',
        password: 'Password123!'
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(400);

      expect(response.body.error).toContain('Email not verified');
    });

    it('should not login with incorrect password', async () => {
      // Create a user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: true
      });
      await user.save();

      const loginData = {
        email: 'test@example.com',
        password: 'WrongPassword123!'
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(400);

      expect(response.body.error).toContain('Invalid credentials');
    });

    it('should not login a non-existent user', async () => {
      const loginData = {
        email: 'nonexistent@example.com',
        password: 'Password123!'
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(400);

      expect(response.body.error).toContain('User not found');
    });
  });

  describe('GET /api/auth/verify-email', () => {
    it('should verify a user email with valid token', async () => {
      // Create an unverified user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: false
      });
      await user.save();

      // Generate a valid token
      const token = generateTestToken(user._id);

      const response = await request(app)
        .get(`/api/auth/verify-email?token=${token}`)
        .expect(200);

      expect(response.body.message).toContain('Email verified successfully');

      // Verify user is now verified in the database
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.verified).toBe(true);
    });

    it('should not verify with an invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/verify-email?token=invalid-token')
        .expect(400);

      expect(response.body.error).toContain('Invalid or expired token');
    });
  });

  describe('GET /api/auth/user', () => {
    it('should get current user with valid token', async () => {
      // Create a user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: true
      });
      await user.save();

      // Generate a valid token
      const token = generateTestToken(user._id);

      const response = await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.username).toBe('testuser');
      expect(response.body.email).toBe('test@example.com');
      // Password should not be included
      expect(response.body.password).toBeUndefined();
    });

    it('should return 401 without token', async () => {
      const response = await request(app)
        .get('/api/auth/user')
        .expect(401);

      expect(response.body.msg).toContain('No token');
    });

    it('should return 401 with invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/user')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.msg).toContain('Token is not valid');
    });
  });

  describe('PUT /api/auth/profile', () => {
    it('should update user profile with valid token', async () => {
      // Create a user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        profilePicture: 'default'
      });
      await user.save();

      // Generate a valid token
      const token = generateTestToken(user._id);

      const updateData = {
        profilePicture: 'new-profile-pic-url'
      };

      const response = await request(app)
        .put('/api/auth/profile')
        .set('Authorization', `Bearer ${token}`)
        .send(updateData)
        .expect(200);

      expect(response.body.profilePicture).toBe('new-profile-pic-url');

      // Verify database update
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.profilePicture).toBe('new-profile-pic-url');
    });

    it('should return 401 without token', async () => {
      const updateData = {
        profilePicture: 'new-profile-pic-url'
      };

      const response = await request(app)
        .put('/api/auth/profile')
        .send(updateData)
        .expect(401);

      expect(response.body.msg).toContain('No token');
    });
  });
}); 