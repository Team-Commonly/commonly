const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const authMiddleware = require('../../../middleware/auth');
const { generateTestToken } = require('../../utils/testUtils');

describe('Auth Middleware Tests', () => {
  beforeEach(() => {
    // Reset environment variables before each test
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  it('should add userId to request when valid token is provided in Authorization header', () => {
    // Create a mock user ID
    const userId = new mongoose.Types.ObjectId();
    
    // Generate a valid token
    const token = generateTestToken(userId);
    
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockImplementation((header) => {
        if (header === 'Authorization') return `Bearer ${token}`;
        return null;
      })
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    const next = jest.fn();
    
    // Call the middleware
    authMiddleware(req, res, next);
    
    // Verify that userId was added to request
    expect(req.userId).toBe(userId.toString());
    expect(req.user.id).toBe(userId.toString());
    
    // Verify that next was called
    expect(next).toHaveBeenCalled();
    
    // Verify that res.status and res.json were not called
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('should add userId to request when valid token is provided in x-auth-token header', () => {
    // Create a mock user ID
    const userId = new mongoose.Types.ObjectId();
    
    // Generate a valid token
    const token = generateTestToken(userId);
    
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockImplementation((header) => {
        if (header === 'x-auth-token') return token;
        return null;
      })
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    const next = jest.fn();
    
    // Call the middleware
    authMiddleware(req, res, next);
    
    // Verify that userId was added to request
    expect(req.userId).toBe(userId.toString());
    expect(req.user.id).toBe(userId.toString());
    
    // Verify that next was called
    expect(next).toHaveBeenCalled();
    
    // Verify that res.status and res.json were not called
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('should return 401 when no token is provided', () => {
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue(null)
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    const next = jest.fn();
    
    // Call the middleware
    authMiddleware(req, res, next);
    
    // Verify that res.status and res.json were called with correct arguments
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('No token')
    }));
    
    // Verify that next was not called
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when invalid token is provided', () => {
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue('Bearer invalid-token')
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    const next = jest.fn();
    
    // Call the middleware
    authMiddleware(req, res, next);
    
    // Verify that res.status and res.json were called with correct arguments
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('Token is not valid')
    }));
    
    // Verify that next was not called
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token with invalid structure is provided', () => {
    // Generate a token with invalid structure (no id field)
    const invalidToken = jwt.sign({ foo: 'bar' }, process.env.JWT_SECRET);
    
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue(`Bearer ${invalidToken}`)
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    const next = jest.fn();
    
    // Call the middleware
    authMiddleware(req, res, next);
    
    // Verify that res.status and res.json were called with correct arguments
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('Invalid token structure')
    }));
    
    // Verify that next was not called
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle alternative token format with user object', () => {
    // Create a mock user ID
    const userId = new mongoose.Types.ObjectId();
    
    // Generate a token with alternative format { user: { id: userId } }
    const token = jwt.sign({ user: { id: userId } }, process.env.JWT_SECRET);
    
    // Mock request, response, and next function
    const req = {
      header: jest.fn().mockReturnValue(`Bearer ${token}`)
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    const next = jest.fn();
    
    // Call the middleware
    authMiddleware(req, res, next);
    
    // Verify that userId was added to request
    expect(req.userId).toBe(userId.toString());
    expect(req.user.id).toBe(userId.toString());
    
    // Verify that next was called
    expect(next).toHaveBeenCalled();
    
    // Verify that res.status and res.json were not called
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
}); 