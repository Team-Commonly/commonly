// The /api/analytics routes aggregate summaries across the whole instance, so
// the router is admin-only. adminAuth is the real middleware here; the Summary
// model is mocked so "nothing was read" is asserted on it.
const request = require('supertest');
const express = require('express');

let mockCaller = 'member-1';

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: mockCaller };
  next();
});
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
const mockSummaryFind = jest.fn();
jest.mock('../../../models/Summary', () => ({ find: (...args) => mockSummaryFind(...args) }));

const User = require('../../../models/User');
const analyticsRoutes = require('../../../routes/analytics');

const app = express();
app.use('/api/analytics', analyticsRoutes);

const setRole = (role) => User.findById.mockResolvedValue({ _id: mockCaller, role });
const PATHS = ['/keywords', '/topics', '/activity', '/users', '/trending', '/summary'];

beforeEach(() => {
  jest.clearAllMocks();
  mockCaller = 'member-1';
  mockSummaryFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  setRole('user');
});

describe('analytics routes are admin-only', () => {
  test.each(PATHS)('a non-admin GET %s is a 403 and reads no summaries', async (path) => {
    const res = await request(app).get(`/api/analytics${path}`);
    expect(res.status).toBe(403);
    expect(mockSummaryFind).not.toHaveBeenCalled();
  });

  test.each(PATHS)('an admin GET %s reaches the route', async (path) => {
    setRole('admin');
    const res = await request(app).get(`/api/analytics${path}`);
    expect(res.status).toBe(200);
    expect(mockSummaryFind).toHaveBeenCalled();
  });
});
