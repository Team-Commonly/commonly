const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// #636 ban enforcement: the middleware does one indexed User read per request
// (banned users / deleted accounts are refused on the NEXT request, not at JWT
// expiry). Mock a live, un-banned user so the happy-path tests still pass;
// individual tests override to simulate banned/deleted.
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(() => ({
    select: () => ({ lean: async () => ({ banned: false }) }),
  })),
}));
const User = require('../../../models/User');
const authMiddleware = require('../../../middleware/auth');
const { generateTestToken } = require('../../utils/testUtils');

describe('Auth Middleware Tests', () => {
  beforeEach(() => {
    // Reset environment variables before each test
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  it('should add userId to request when valid token is provided in Authorization header', async () => {
    // Create a mock user ID
    const userId = new mongoose.Types.ObjectId();

    // Generate a valid token
    const token = generateTestToken(userId);

    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockImplementation((header) => {
        if (header === 'Authorization') return `Bearer ${token}`;
        return null;
      }),
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    // Call the middleware
    await authMiddleware(req, res, next);

    // Verify that userId was added to request
    expect(req.userId).toBe(userId.toString());
    expect(req.user.id).toBe(userId.toString());

    // Verify that next was called
    expect(next).toHaveBeenCalled();

    // Verify that res.status and res.json were not called
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('should add userId to request when valid token is provided in x-auth-token header', async () => {
    // Create a mock user ID
    const userId = new mongoose.Types.ObjectId();

    // Generate a valid token
    const token = generateTestToken(userId);

    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockImplementation((header) => {
        if (header === 'x-auth-token') return token;
        return null;
      }),
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    // Call the middleware
    await authMiddleware(req, res, next);

    // Verify that userId was added to request
    expect(req.userId).toBe(userId.toString());
    expect(req.user.id).toBe(userId.toString());

    // Verify that next was called
    expect(next).toHaveBeenCalled();

    // Verify that res.status and res.json were not called
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('should return 401 when no token is provided', async () => {
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue(null),
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    // Call the middleware
    await authMiddleware(req, res, next);

    // Verify that res.status and res.json were called with correct arguments
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('No token'),
      }),
    );

    // Verify that next was not called
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when invalid token is provided', async () => {
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue('Bearer invalid-token'),
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    // Call the middleware
    await authMiddleware(req, res, next);

    // Verify that res.status and res.json were called with correct arguments
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('Token is not valid'),
      }),
    );

    // Verify that next was not called
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token with invalid structure is provided', async () => {
    // Generate a token with invalid structure (no id field)
    const invalidToken = jwt.sign({ foo: 'bar' }, process.env.JWT_SECRET);

    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue(`Bearer ${invalidToken}`),
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    // Call the middleware
    await authMiddleware(req, res, next);

    // Verify that res.status and res.json were called with correct arguments
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('Invalid token structure'),
      }),
    );

    // Verify that next was not called
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle alternative token format with user object', async () => {
    // Create a mock user ID
    const userId = new mongoose.Types.ObjectId();

    // Generate a token with alternative format { user: { id: userId } }
    const token = jwt.sign({ user: { id: userId } }, process.env.JWT_SECRET);

    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue(`Bearer ${token}`),
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    // Call the middleware
    await authMiddleware(req, res, next);

    // Verify that userId was added to request
    expect(req.userId).toBe(userId.toString());
    expect(req.user.id).toBe(userId.toString());

    // Verify that next was called
    expect(next).toHaveBeenCalled();

    // Verify that res.status and res.json were not called
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 403 when the account is banned (ban bites on next request)', async () => {
    const userId = new mongoose.Types.ObjectId();
    const token = generateTestToken(userId);
    User.findById.mockReturnValueOnce({
      select: () => ({ lean: async () => ({ banned: true }) }),
    });
    const req = { header: jest.fn((h) => (h === 'Authorization' ? `Bearer ${token}` : null)) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the account no longer exists (deleted user, live JWT)', async () => {
    const userId = new mongoose.Types.ObjectId();
    const token = generateTestToken(userId);
    User.findById.mockReturnValueOnce({
      select: () => ({ lean: async () => null }),
    });
    const req = { header: jest.fn((h) => (h === 'Authorization' ? `Bearer ${token}` : null)) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

});
