const request = require('supertest');
const express = require('express');
// eslint-disable-next-line no-unused-vars
const mongoose = require('mongoose');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const DeviceAuthorization = require('../../models/DeviceAuthorization');
const { hashDeviceCredential } = require('../../services/deviceAuthorizationService');
const authRoutes = require('../../routes/auth');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
} = require('../utils/testUtils');

// Mock SendGrid to prevent actual emails from being sent
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue(true),
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
    delete process.env.REGISTRATION_INVITE_ONLY;
    delete process.env.REGISTRATION_INVITE_CODES;
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
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
      expect(typeof user.verified).toBe('boolean');
    });

    it('creates a default private workspace pod owned by the new user', async () => {
      const userData = {
        username: 'workspaceowner',
        email: 'workspace@example.com',
        password: 'Password123!',
      };

      await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      const user = await User.findOne({ email: userData.email });
      expect(user).toBeTruthy();

      const pods = await Pod.find({ createdBy: user._id });
      expect(pods).toHaveLength(1);
      const pod = pods[0];
      expect(pod.name).toBe('My Workspace');
      expect(pod.type).toBe('chat');
      expect(pod.joinPolicy).toBe('invite-only');
      // Membership changed by plan D4 (the Guide, PR #911; renamed Scout —
      // agentName 'scout' — 2026-08-13): the workspace's first inhabitants
      // are the creator AND the per-user scout agent — the "sole member"
      // assertion encoded the pre-Guide behavior.
      const memberIds = pod.members.map((m) => m.toString());
      expect(memberIds).toContain(user._id.toString());
      const scoutUser = await User.findOne({ isBot: true, 'botMetadata.agentName': 'scout' });
      expect(scoutUser).toBeTruthy();
      expect(memberIds).toContain(scoutUser._id.toString());
      expect(memberIds).toHaveLength(2);
    });

    it('defaults entitlements.cloudAgents to false for new signups', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({
          username: 'gateduser',
          email: 'gated@example.com',
          password: 'Password123!',
        })
        .expect(201);

      const user = await User.findOne({ email: 'gated@example.com' });
      expect(user.entitlements.cloudAgents).toBe(false);
    });

    it('should return 400 for existing user', async () => {
      // Create a user first
      const existingUser = new User({
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'Password123!',
      });
      await existingUser.save();

      // Try to register with the same email
      const userData = {
        username: 'newuser',
        email: 'existing@example.com',
        password: 'Password123!',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toContain('User already exists');
    });

    it('should return 400 for existing username', async () => {
      const existingUser = new User({
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'Password123!',
      });
      await existingUser.save();

      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'existinguser',
          email: 'different@example.com',
          password: 'Password123!',
        })
        .expect(400);

      expect(response.body.error).toContain('Username already exists');
    });

    it('should validate required fields', async () => {
      // Missing username
      const missingUsername = {
        email: 'test@example.com',
        password: 'Password123!',
      };

      await request(app)
        .post('/api/auth/register')
        .send(missingUsername)
        .expect(400);

      // Missing email
      const missingEmail = {
        username: 'testuser',
        password: 'Password123!',
      };

      await request(app)
        .post('/api/auth/register')
        .send(missingEmail)
        .expect(400);

      // Missing password
      const missingPassword = {
        username: 'testuser',
        email: 'test@example.com',
      };

      await request(app)
        .post('/api/auth/register')
        .send(missingPassword)
        .expect(400);
    });

    it('should reject registration without invite code when invite-only mode is enabled', async () => {
      process.env.REGISTRATION_INVITE_ONLY = '1';
      process.env.REGISTRATION_INVITE_CODES = 'alpha-123';

      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!',
        })
        .expect(403);

      expect(response.body.code).toBe('INVITATION_REQUIRED');
    });

    it('should register when invite code is valid in invite-only mode', async () => {
      process.env.REGISTRATION_INVITE_ONLY = '1';
      process.env.REGISTRATION_INVITE_CODES = 'alpha-123';

      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!',
          invitationCode: 'alpha-123',
        })
        .expect(201);

      expect(response.body.message).toContain('User registered successfully');
    });
  });

  describe('GET /api/auth/registration-policy', () => {
    it('should return invite-only policy state', async () => {
      process.env.REGISTRATION_INVITE_ONLY = '1';
      process.env.REGISTRATION_INVITE_CODES = 'alpha-123';

      const response = await request(app)
        .get('/api/auth/registration-policy')
        .expect(200);

      expect(response.body).toMatchObject({
        inviteOnly: true,
        invitationRequired: true,
        hasInvitationCodes: true,
        registrationOpen: true,
      });
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login a verified user successfully', async () => {
      // Create a verified user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: true,
      });
      await user.save();

      const loginData = {
        email: 'test@example.com',
        password: 'Password123!',
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
        verified: false,
      });
      await user.save();

      const loginData = {
        email: 'test@example.com',
        password: 'Password123!',
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
        verified: true,
      });
      await user.save();

      const loginData = {
        email: 'test@example.com',
        password: 'WrongPassword123!',
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
        password: 'Password123!',
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
        verified: false,
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
        verified: true,
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
      const response = await request(app).get('/api/auth/user').expect(401);

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

  describe('CLI device authorization', () => {
    const createVerifiedUser = async () => {
      const user = new User({
        username: 'device-owner',
        email: 'device-owner@example.com',
        password: 'Password123!',
        verified: true,
      });
      await user.save();
      return user;
    };

    const startAuthorization = async () => request(app)
      .post('/api/auth/device/start')
      .send({ clientName: 'commonly-cli', clientVersion: '0.1.26', hostname: 'sam-laptop' })
      .expect(201);

    it('declares a zero-delay TTL reaper in addition to endpoint expiry checks', () => {
      const expiryIndex = DeviceAuthorization.schema.indexes()
        .find(([keys]) => Object.prototype.hasOwnProperty.call(keys, 'expiresAt'));
      expect(expiryIndex).toBeDefined();
      expect(expiryIndex[1]).toEqual(expect.objectContaining({ expireAfterSeconds: 0 }));
    });

    it('hands an approved token to exactly one poller and persists only its digest', async () => {
      const user = await createVerifiedUser();
      const browserToken = generateTestToken(user._id);
      const start = await startAuthorization();

      expect(start.body).toMatchObject({
        verifyUrl: 'http://localhost:3000/cli/authorize',
        expiresIn: 600,
        interval: 5,
      });
      expect(start.body.deviceCode).toBeTruthy();
      expect(start.body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

      const storedRequest = await DeviceAuthorization.findOne();
      expect(storedRequest.deviceCodeHash).not.toBe(start.body.deviceCode);
      expect(storedRequest.userCodeHash).not.toBe(start.body.userCode.replace('-', ''));

      await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: start.body.deviceCode })
        .expect(200)
        .expect({ status: 'authorization_pending' });

      const confirmation = await request(app)
        .post('/api/auth/device/authorize')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ userCode: start.body.userCode })
        .expect(200);
      expect(confirmation.body).toMatchObject({
        status: 'pending',
        request: { hostname: 'sam-laptop', clientName: 'commonly-cli', clientVersion: '0.1.26' },
      });

      await request(app)
        .post('/api/auth/device/authorize')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ userCode: start.body.userCode, decision: 'authorize' })
        .expect(200)
        .expect({ status: 'authorized' });

      const granted = await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: start.body.deviceCode })
        .expect(200);
      expect(granted.body).toMatchObject({ username: 'device-owner', userId: user._id.toString() });
      expect(granted.body.token).toMatch(/^cm_[a-f0-9]{64}$/);

      // The transient handoff is consumed atomically; a duplicate poll never
      // returns a second copy of the bearer.
      await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: start.body.deviceCode })
        .expect(200)
        .expect({ status: 'already_used' });

      const persistedUser = await User.findById(user._id).select('deviceTokens');
      expect(persistedUser.deviceTokens).toHaveLength(1);
      expect(persistedUser.deviceTokens[0].label).toBe('sam-laptop · commonly-cli');
      expect(persistedUser.deviceTokens[0].tokenHash).not.toBe(granted.body.token);
      expect(JSON.stringify(persistedUser)).not.toContain(granted.body.token);

      // It is a normal user bearer until explicitly revoked.
      await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${granted.body.token}`)
        .expect(200)
        .expect((response) => expect(response.body.deviceTokens).toBeUndefined());

      const devices = await request(app)
        .get('/api/auth/devices')
        .set('Authorization', `Bearer ${browserToken}`)
        .expect(200);
      expect(devices.body.devices).toEqual([expect.objectContaining({
        label: 'sam-laptop · commonly-cli',
      })]);
      expect(devices.body.devices[0].tokenHash).toBeUndefined();
      expect(JSON.stringify(devices.body)).not.toContain(granted.body.token);

      await request(app)
        .delete(`/api/auth/devices/${devices.body.devices[0].id}`)
        .set('Authorization', `Bearer ${browserToken}`)
        .expect(200);
      await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${granted.body.token}`)
        .expect(401);
    });

    it('returns slow_down, denied, and expired terminal states without minting a token', async () => {
      const user = await createVerifiedUser();
      const browserToken = generateTestToken(user._id);

      const pending = await startAuthorization();
      await request(app).post('/api/auth/device/poll').send({ deviceCode: pending.body.deviceCode }).expect(200);
      await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: pending.body.deviceCode })
        .expect(200)
        .expect({ status: 'slow_down' });

      const denied = await startAuthorization();
      await request(app)
        .post('/api/auth/device/authorize')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ userCode: denied.body.userCode, decision: 'deny' })
        .expect(200)
        .expect({ status: 'denied' });
      await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: denied.body.deviceCode })
        .expect(200)
        .expect({ status: 'denied' });

      const expired = await startAuthorization();
      await DeviceAuthorization.updateOne(
        { deviceCodeHash: hashDeviceCredential(expired.body.deviceCode) },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: expired.body.deviceCode })
        .expect(200)
        .expect({ status: 'expired' });
      expect((await User.findById(user._id).select('deviceTokens')).deviceTokens).toHaveLength(0);
    });

    it('does not mint a bearer when an approved terminal abandons the flow', async () => {
      const user = await createVerifiedUser();
      const browserToken = generateTestToken(user._id);
      const started = await startAuthorization();

      await request(app)
        .post('/api/auth/device/authorize')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ userCode: started.body.userCode, decision: 'authorize' })
        .expect(200)
        .expect({ status: 'authorized' });

      await DeviceAuthorization.updateOne(
        { deviceCodeHash: hashDeviceCredential(started.body.deviceCode) },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      await request(app)
        .post('/api/auth/device/poll')
        .send({ deviceCode: started.body.deviceCode })
        .expect(200)
        .expect({ status: 'expired' });

      expect((await User.findById(user._id).select('deviceTokens')).deviceTokens).toHaveLength(0);
    });
  });

  describe('PUT /api/auth/profile', () => {
    it('should update user profile with valid token', async () => {
      // Create a user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        profilePicture: 'default',
      });
      await user.save();

      // Generate a valid token
      const token = generateTestToken(user._id);

      const updateData = {
        profilePicture: 'https://api-dev.commonly.me/api/uploads/new-profile-pic.png',
      };

      const response = await request(app)
        .put('/api/auth/profile')
        .set('Authorization', `Bearer ${token}`)
        .send(updateData)
        .expect(200);

      expect(response.body.profilePicture).toBe('/api/uploads/new-profile-pic.png');

      // Verify database update
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.profilePicture).toBe('/api/uploads/new-profile-pic.png');
    });

    it('should return 401 without token', async () => {
      const updateData = {
        profilePicture: 'new-profile-pic-url',
      };

      const response = await request(app)
        .put('/api/auth/profile')
        .send(updateData)
        .expect(401);

      expect(response.body.msg).toContain('No token');
    });
  });
});
