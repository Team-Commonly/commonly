const jwt = require('jsonwebtoken');
const { authenticate } = require('../../../middleware/authMiddleware');

describe('authenticate middleware', () => {
  const secret = 'testsecret';
  beforeAll(() => {
    process.env.JWT_SECRET = secret;
  });

  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('adds userId to request with valid token', () => {
    const token = jwt.sign({ id: 'u1' }, secret);
    const req = { header: jest.fn(() => `Bearer ${token}`) };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);
    expect(req.userId).toBe('u1');
    expect(next).toHaveBeenCalled();
  });

  it('responds 401 when token missing', () => {
    const req = { header: jest.fn(() => null) };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 400 when token invalid', () => {
    const req = { header: jest.fn(() => 'Bearer badtoken') };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
  });
});
