const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'user1';
  next();
});

const mockFindOne = jest.fn();
jest.mock('../../../models/PodInvite', () => ({
  PodInvite: { findOne: (...args) => mockFindOne(...args), create: jest.fn() },
}));

// eslint-disable-next-line import/no-unresolved, import/extensions
const Pod = require('../../../models/Pod');
jest.mock('../../../models/Pod');

// eslint-disable-next-line import/no-unresolved, import/extensions
const routes = require('../../../routes/podInvites');

describe('GET /api/invites/:token (authenticated)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/api', routes);
    mockFindOne.mockResolvedValue({
      token: 'tok123', podId: 'p1', expiresAt: null, isUsable: () => true,
    });
  });

  const resolveForOwner = async (createdBy) => {
    const select = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({
      _id: 'p1', name: 'My Workspace', description: 'Your private workspace',
      type: 'chat', members: ['user1'], createdBy,
    }) });
    Pod.findById.mockReturnValue({ select });
    const response = await request(app).get('/api/invites/tok123').expect(200);
    expect(select).toHaveBeenCalledWith(expect.stringContaining('createdBy'));
    return response.body;
  };

  it('marks the creator as owner without exposing their ID in the invite payload', async () => {
    const body = await resolveForOwner('user1');
    expect(body.isOwner).toBe(true);
    expect(body.pod).not.toHaveProperty('createdBy');
  });

  it('marks another member as a guest of the workspace', async () => {
    const body = await resolveForOwner('other-user');
    expect(body.isOwner).toBe(false);
  });
});
