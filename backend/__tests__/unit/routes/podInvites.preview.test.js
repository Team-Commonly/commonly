const request = require('supertest');
const express = require('express');

// Regression for the anonymous invite PREVIEW endpoint (share-pod funnel):
// logged-out visitors may see pod NAME + member count for a valid invite —
// and nothing else. No podId, no description, no member identities. Invalid,
// expired, and DM-pod invites all collapse to the same 404 so the endpoint
// can't probe which tokens exist for what.

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const mockFindOne = jest.fn();
jest.mock('../../../models/PodInvite', () => ({
  PodInvite: { findOne: (...args) => mockFindOne(...args), create: jest.fn() },
}));

const Pod = require('../../../models/Pod');
jest.mock('../../../models/Pod');

jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm', 'agent-admin']),
}));

const routes = require('../../../routes/podInvites');

const leanChain = (value) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }) });
const usableInvite = (overrides = {}) => ({
  token: 'tok123',
  podId: 'p1',
  expiresAt: null,
  isUsable: () => true,
  ...overrides,
});

describe('GET /api/invites/:token/preview (anonymous)', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    jest.clearAllMocks();
  });

  it('returns name + member count only for a valid invite', async () => {
    mockFindOne.mockResolvedValue(usableInvite());
    Pod.findById.mockReturnValue(leanChain({
      _id: 'p1',
      name: 'Launch Prep',
      description: 'secret internal notes',
      type: 'chat',
      members: ['a', 'b', 'c'],
    }));

    const res = await request(app).get('/api/invites/tok123/preview').expect(200);

    expect(res.body.pod).toEqual({ name: 'Launch Prep', memberCount: 3 });
    // Minimal disclosure: nothing beyond name + count leaks to anonymous.
    expect(JSON.stringify(res.body)).not.toContain('p1');
    expect(JSON.stringify(res.body)).not.toContain('secret internal notes');
  });

  it('404s an unknown token', async () => {
    mockFindOne.mockResolvedValue(null);
    await request(app).get('/api/invites/nope/preview').expect(404);
  });

  it('404s an expired/exhausted invite', async () => {
    mockFindOne.mockResolvedValue(usableInvite({ isUsable: () => false }));
    await request(app).get('/api/invites/tok123/preview').expect(404);
  });

  it('404s DM-pod invites with the same message as unknown tokens', async () => {
    mockFindOne.mockResolvedValue(usableInvite());
    Pod.findById.mockReturnValue(leanChain({ _id: 'p1', name: 'Admin: solo', type: 'agent-admin', members: ['a', 'b'] }));

    const res = await request(app).get('/api/invites/tok123/preview').expect(404);
    expect(res.body.msg).toBe('Invite invalid or expired');
  });
});
