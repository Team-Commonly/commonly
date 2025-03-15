const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../../models/User');
const authController = require('../../../controllers/authController');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

// Mock SendGrid to prevent actual emails from being sent
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue(true)
}));

// Mock bcrypt
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashedPassword'),
  compare: jest.fn().mockResolvedValue(true)
}));

// Mock JWT
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn().mockReturnValue({ id: 'mockUserId' })
}));

describe('Auth Controller Tests', () => {
  // Setup and teardown for MongoDB
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      const req = {
        body: {
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('User registered successfully')
      }));

      // Verify user was created in the database
      const user = await User.findOne({ email: req.body.email });
      expect(user).toBeTruthy();
      expect(user.username).toBe(req.body.username);
      expect(user.verified).toBe(false);
    });

    it('should not register a user with an existing email', async () => {
      // Create a user first
      const existingUser = new User({
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'Password123!'
      });
      await existingUser.save();

      const req = {
        body: {
          username: 'newuser',
          email: 'existing@example.com', // Same email as existing user
          password: 'Password123!'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('User already exists')
      }));
    });
  });

  describe('login', () => {
    it('should login a verified user successfully', async () => {
      // Create a verified user
      const password = 'Password123!';
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: hashedPassword,
        verified: true
      });
      await user.save();

      const req = {
        body: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      // Mock the JWT signing to return a consistent token for testing
      const mockToken = 'test-jwt-token';
      jest.spyOn(jwt, 'sign').mockImplementation(() => mockToken);

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith({
        token: mockToken,
        verified: true
      });
    });

    it('should not login an unverified user', async () => {
      // Create an unverified user
      const password = 'Password123!';
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: hashedPassword,
        verified: false
      });
      await user.save();

      const req = {
        body: {
          email: 'test@example.com',
          password: 'Password123!'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Email not verified')
      }));
    });

    it('should not login with incorrect password', async () => {
      // Create a verified user
      const password = 'Password123!';
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: hashedPassword,
        verified: true
      });
      await user.save();

      // Mock bcrypt.compare to return false for this test only
      bcrypt.compare.mockResolvedValueOnce(false);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'WrongPassword123!'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Invalid credentials')
      }));
    });

    it('should not login a non-existent user', async () => {
      const req = {
        body: {
          email: 'nonexistent@example.com',
          password: 'Password123!'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('User not found')
      }));
    });
  });

  describe('verifyEmail', () => {
    it('should verify a user email with valid token', async () => {
      // Create an unverified user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: false
      });
      await user.save();

      // Set up the mock to return this specific user ID
      jwt.verify.mockReturnValueOnce({ id: user._id.toString() });

      const req = {
        query: {
          token: 'valid-token'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.verifyEmail(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Email verified successfully')
      }));

      // Verify the user in the database was updated
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.verified).toBe(true);
    });

    it('should not verify with an invalid token', async () => {
      const req = {
        query: { token: 'invalid-token' }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.verifyEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Invalid or expired token')
      }));
    });
  });

  describe('getCurrentUser', () => {
    it('should return the current user', async () => {
      // Create a user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        verified: true
      });
      await user.save();

      const req = {
        userId: user._id
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.getCurrentUser(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        username: 'testuser',
        email: 'test@example.com'
      }));
      // Password should not be included
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({
        password: expect.anything()
      }));
    });

    it('should return 404 if user not found', async () => {
      const req = {
        userId: new mongoose.Types.ObjectId()
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.getCurrentUser(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('User not found')
      }));
    });
  });

  describe('updateProfile', () => {
    it('should update user profile picture', async () => {
      // Create a user
      const user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password123!',
        profilePicture: 'default'
      });
      await user.save();

      const req = {
        userId: user._id,
        body: {
          profilePicture: 'new-profile-pic-url'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.updateProfile(req, res);

      // Verify response
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        profilePicture: 'new-profile-pic-url'
      }));

      // Verify database update
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.profilePicture).toBe('new-profile-pic-url');
    });

    it('should return 404 if user not found', async () => {
      const req = {
        userId: new mongoose.Types.ObjectId(),
        body: {
          profilePicture: 'new-profile-pic-url'
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.updateProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('User not found')
      }));
    });
  });
}); 