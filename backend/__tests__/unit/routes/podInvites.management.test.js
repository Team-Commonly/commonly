const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const mockFind = jest.fn();
const mockFindOne = jest.fn();
jest.mock('../../../models/PodInvite', () => ({
  PodInvite: {
    find: (...args) => mockFind(...args),
    findOne: (...args) => mockFindOne(...args),
    create: jest.fn(),
  },
}));

// eslint-disable-next-line import/no-unresolved, import/extensions
const Pod = require('../../../models/Pod');

jest.mock('../../../models/Pod');

jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']),
}));

// eslint-disable-next-line import/no-unresolved, import/extensions
const routes = require('../../../routes/podInvites');

const POD_ID = '507f1f77bcf86cd799439011';
const TOKEN = 'a'.repeat(32);
const OTHER_TOKEN = 'b'.repeat(32);

const memberPod = (overrides = {}) => ({
  _id: POD_ID,
  type: 'chat',
  createdBy: 'owner',
  members: ['user1'],
  ...overrides,
});

const listChain = (rows) => ({
  sort: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(rows),
    }),
  }),
});

describe('pod invite management routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    jest.clearAllMocks();
  });

  it('lists non-revoked invites for a pod member', async () => {
    Pod.findById.mockResolvedValue(memberPod());
    mockFind.mockReturnValue(listChain([{
      token: TOKEN,
      createdBy: { _id: 'creator1', username: 'Aria' },
      createdAt: new Date('2026-07-21T10:00:00Z'),
      expiresAt: null,
      maxUses: 10,
      useCount: 2,
      revokedAt: null,
    }]));

    const res = await request(app).get(`/api/pods/${POD_ID}/invites`).expect(200);

    expect(String(Pod.findById.mock.calls[0][0])).toBe(POD_ID);
    expect(mockFind).toHaveBeenCalledWith({ podId: POD_ID, revokedAt: null });
    expect(res.body).toEqual([expect.objectContaining({
      token: TOKEN,
      createdBy: { _id: 'creator1', username: 'Aria' },
      maxUses: 10,
      uses: 2,
    })]);
    expect(res.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ token: OTHER_TOKEN }),
    ]));
  });

  it('refuses to list invites for a non-member', async () => {
    Pod.findById.mockResolvedValue(memberPod({ members: ['someone-else'] }));

    await request(app).get(`/api/pods/${POD_ID}/invites`).expect(403);

    expect(mockFind).not.toHaveBeenCalled();
  });

  it('soft-revokes an invite for a pod member', async () => {
    const invite = {
      token: TOKEN,
      podId: POD_ID,
      revokedAt: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(invite);
    Pod.findById.mockResolvedValue(memberPod());

    const res = await request(app).delete(`/api/invites/${TOKEN}`).expect(200);

    expect(mockFindOne).toHaveBeenCalledWith({ token: TOKEN });
    expect(invite.revokedAt).toBeInstanceOf(Date);
    expect(invite.save).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ ok: true });
  });

  it('refuses to revoke an invite for a non-member', async () => {
    const invite = {
      token: TOKEN,
      podId: POD_ID,
      revokedAt: null,
      save: jest.fn(),
    };
    mockFindOne.mockResolvedValue(invite);
    Pod.findById.mockResolvedValue(memberPod({ members: ['someone-else'] }));

    await request(app).delete(`/api/invites/${TOKEN}`).expect(403);

    expect(invite.save).not.toHaveBeenCalled();
  });

  it('rejects a revoked invite on redemption', async () => {
    mockFindOne.mockResolvedValue({
      token: TOKEN,
      isUsable: () => false,
    });

    await request(app).post(`/api/invites/${TOKEN}/redeem`).send({}).expect(404);

    expect(Pod.findById).not.toHaveBeenCalled();
  });

  it('returns the stable refusal code when a personal DM invite is redeemed', async () => {
    mockFindOne.mockResolvedValue({
      token: TOKEN,
      podId: POD_ID,
      isUsable: () => true,
    });
    Pod.findById.mockResolvedValue(memberPod({ type: 'agent-dm' }));

    const res = await request(app).post(`/api/invites/${TOKEN}/redeem`).send({}).expect(403);

    expect(res.body.code).toBe('dm_membership_refused');
  });
});
