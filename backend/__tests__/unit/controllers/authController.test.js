const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../../models/User');
const authController = require('../../../controllers/authController');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

// Mock SendGrid to prevent actual emails from being sent
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue(true),
}));

// Mock Bcrypt
jest.mock('bcryptjs', () => ({
  genSalt: jest.fn().mockResolvedValue('mocksalt'),
  hash: jest.fn().mockResolvedValue('hashedPassword'),
  compare: jest.fn().mockResolvedValue(true),
}));

// Mock JWT
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn().mockReturnValue({ id: 'mockUserId' }),
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
      // Create a mock for bcrypt
      bcrypt.hash.mockResolvedValueOnce('hashedPassword');

      // Create a mock for SendGrid
      const sendGridMock = require('@sendgrid/mail');
      sendGridMock.send.mockResolvedValueOnce(true);

      // Mock User.findOne to return null (user doesn't exist)
      User.findOne = jest.fn().mockResolvedValueOnce(null);

      // Mock User.prototype.save to return the user
      const savedUser = {
        _id: 'mockedUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: false,
      };
      const saveMock = jest.fn().mockResolvedValueOnce(savedUser);
      User.prototype.save = saveMock;

      const req = {
        body: {
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      // Verify mocks were called correctly
      expect(User.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
      expect(bcrypt.hash).toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalled();
      expect(sendGridMock.send).toHaveBeenCalled();

      // Verify response
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('User registered successfully'),
        }),
      );
    });

    it('should not register a user with an existing email', async () => {
      // Mock User.findOne to return an existing user
      const existingUser = {
        _id: 'existingUserId',
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'hashedPassword',
      };

      // Mock findOne to return the existing user
      User.findOne = jest.fn().mockResolvedValueOnce(existingUser);

      const req = {
        body: {
          username: 'newuser',
          email: 'existing@example.com', // Same email as existing user
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User already exists'),
        }),
      );
    });
  });

  describe('login', () => {
    it('should login a verified user successfully', async () => {
      // Mock a verified user
      const user = {
        _id: 'testUserId',
        id: 'testUserId', // Some implementations use id instead of _id
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: true,
        profilePicture: 'default',
      };

      // Mock User.findOne to return the verified user
      User.findOne = jest.fn().mockResolvedValueOnce(user);

      // Mock bcrypt.compare to return true
      bcrypt.compare.mockResolvedValueOnce(true);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      // Mock the JWT signing to return a consistent token for testing
      const mockToken = 'test-jwt-token';
      jest.spyOn(jwt, 'sign').mockImplementation(() => mockToken);

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          token: mockToken,
          verified: true,
          user: expect.objectContaining({
            id: expect.any(String),
            username: 'testuser',
            email: 'test@example.com',
            profilePicture: expect.any(String),
          }),
        }),
      );
    });

    it('should not login an unverified user', async () => {
      // Mock an unverified user
      const user = {
        _id: 'testUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: false,
      };

      // Mock User.findOne to return the unverified user
      User.findOne = jest.fn().mockResolvedValueOnce(user);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Email not verified'),
        }),
      );
    });

    it('should not login with incorrect password', async () => {
      // Mock a verified user
      const user = {
        _id: 'testUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: true,
      };

      // Mock User.findOne to return the user
      User.findOne = jest.fn().mockResolvedValueOnce(user);

      // Mock bcrypt.compare to return false for this test only
      bcrypt.compare.mockResolvedValueOnce(false);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'WrongPassword123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Invalid credentials'),
        }),
      );
    });

    it('should not login a non-existent user', async () => {
      const req = {
        body: {
          email: 'nonexistent@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User not found'),
        }),
      );
    });
  });

  describe('verifyEmail', () => {
    it('should verify a user email with valid token', async () => {
      // Create an unverified user object (not saved to DB)
      const userId = new mongoose.Types.ObjectId().toString();
      const updatedUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        verified: true,
      };

      // Mock jwt.verify to return our user ID
      jwt.verify.mockReturnValueOnce({ id: userId });

      // Mock findByIdAndUpdate to return the updated user
      User.findByIdAndUpdate = jest.fn().mockResolvedValueOnce(updatedUser);

      const req = {
        query: {
          token: 'valid-token',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.verifyEmail(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Email verified successfully'),
        }),
      );
    });

    it('should not verify with an invalid token', async () => {
      // Mock jwt.verify to throw an error
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const req = {
        query: { token: 'invalid-token' },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.verifyEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Invalid or expired token'),
        }),
      );
    });
  });

  describe('getCurrentUser', () => {
    it('should return the current user', async () => {
      // Create a mock user ID
      const userId = new mongoose.Types.ObjectId().toString();

      // Create a mock user with select method
      const mockUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        verified: true,
        profilePicture: 'default',
      };

      // Mock User.findById().select() chain
      const mockSelect = jest.fn().mockResolvedValueOnce(mockUser);
      User.findById = jest.fn().mockReturnValue({
        select: mockSelect,
      });

      const req = {
        userId,
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.getCurrentUser(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'testuser',
          email: 'test@example.com',
        }),
      );
      // Password should not be included
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({
          password: expect.anything(),
        }),
      );
    });

    it('should return 404 if user not found', async () => {
      // Create a mock user ID
      const userId = new mongoose.Types.ObjectId().toString();

      // Mock User.findById().select() to return null
      const mockSelect = jest.fn().mockResolvedValueOnce(null);
      User.findById = jest.fn().mockReturnValue({
        select: mockSelect,
      });

      const req = {
        userId,
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.getCurrentUser(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User not found'),
        }),
      );
    });
  });

  describe('updateProfile', () => {
    it('should update user profile picture', async () => {
      // Create a mock user ID and user objects
      const userId = new mongoose.Types.ObjectId().toString();

      // Initial user returned by findById
      const initialUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        profilePicture: 'default',
        save: jest.fn().mockResolvedValueOnce(true),
      };

      // Updated user returned by findById().select()
      const updatedUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        profilePicture: 'new-profile-pic-url',
      };

      // First mock for the initial findById
      User.findById = jest.fn().mockResolvedValueOnce(initialUser);

      // Second mock for the findById().select() after update
      const mockSelect = jest.fn().mockResolvedValueOnce(updatedUser);
      User.findById.mockReturnValueOnce({
        select: mockSelect,
      });

      const req = {
        userId,
        body: {
          profilePicture: 'new-profile-pic-url',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.updateProfile(req, res);

      // Verify response
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          profilePicture: 'new-profile-pic-url',
        }),
      );

      // Verify save was called
      expect(initialUser.save).toHaveBeenCalled();
    });

    it('should return 404 if user not found', async () => {
      // Create a mock user ID
      const userId = new mongoose.Types.ObjectId().toString();

      // Mock findById to return null (user not found)
      User.findById = jest.fn().mockResolvedValueOnce(null);

      const req = {
        userId,
        body: {
          profilePicture: 'new-profile-pic-url',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.updateProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User not found'),
        }),
      );
    });
  });
});
