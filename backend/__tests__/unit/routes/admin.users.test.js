jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = req.user || { id: 'admin-1' };
  req.userId = req.user.id;
  next();
});
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());

jest.mock('../../../models/User', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../../../models/InvitationCode', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/WaitlistRequest', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  create: jest.fn(),
}));
jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const User = require('../../../models/User');
const InvitationCode = require('../../../models/InvitationCode');
const WaitlistRequest = require('../../../models/WaitlistRequest');
const router = require('../../../routes/admin/users');

function getRouteHandler(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === path && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('admin users routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists users for admin', async () => {
    const handler = getRouteHandler('/', 'get');
    const req = { query: {} };
    const res = createRes();
    User.find.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: () => Promise.resolve([
            {
              _id: 'u1',
              username: 'alice',
              email: 'a@example.com',
              role: 'user',
              verified: true,
            },
          ]),
        }),
      }),
    });

    await handler(req, res);

    expect(User.find).toHaveBeenCalledWith({});
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1,
        users: [
          expect.objectContaining({
            id: 'u1',
            username: 'alice',
          }),
        ],
      }),
    );
  });

  it('deletes a non-bot user', async () => {
    const handler = getRouteHandler('/:userId', 'delete');
    const req = {
      params: { userId: 'u2' },
      user: { id: 'admin-1' },
    };
    const res = createRes();
    const target = {
      _id: 'u2',
      role: 'user',
      isBot: false,
      deleteOne: jest.fn().mockResolvedValue(true),
    };
    User.findById.mockResolvedValue(target);

    await handler(req, res);

    expect(target.deleteOne).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ message: 'User deleted successfully' });
  });

  it('updates a user role', async () => {
    const handler = getRouteHandler('/:userId/role', 'patch');
    const req = {
      params: { userId: 'u2' },
      body: { role: 'admin' },
      user: { id: 'admin-1' },
    };
    const res = createRes();
    const target = {
      _id: 'u2',
      username: 'bob',
      email: 'b@example.com',
      role: 'user',
      verified: true,
      save: jest.fn().mockResolvedValue(true),
    };
    User.findById.mockResolvedValue(target);

    await handler(req, res);

    expect(target.role).toBe('admin');
    expect(target.save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'User role updated successfully',
        user: expect.objectContaining({ id: 'u2', role: 'admin' }),
      }),
    );
  });

  it('creates invitation code', async () => {
    const handler = getRouteHandler('/invitations', 'post');
    const req = {
      user: { id: 'admin-1' },
      body: {
        code: 'team-001',
        maxUses: 3,
        note: 'design partner',
      },
    };
    const res = createRes();
    InvitationCode.findOne.mockResolvedValue(null);
    InvitationCode.create.mockResolvedValue({ _id: 'inv-1' });
    InvitationCode.findById.mockReturnValue({
      populate: () => ({
        lean: () => Promise.resolve({
          _id: 'inv-1',
          code: 'TEAM-001',
          maxUses: 3,
          useCount: 0,
          isActive: true,
          note: 'design partner',
          createdBy: { _id: 'admin-1', username: 'admin', email: 'admin@test.com' },
        }),
      }),
    });

    await handler(req, res);

    expect(InvitationCode.create).toHaveBeenCalledWith(expect.objectContaining({
      code: 'TEAM-001',
      maxUses: 3,
      createdBy: 'admin-1',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('revokes invitation code', async () => {
    const handler = getRouteHandler('/invitations/:invitationId/revoke', 'post');
    const req = { params: { invitationId: 'inv-1' } };
    const res = createRes();
    InvitationCode.findByIdAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({
        _id: 'inv-1',
        code: 'TEAM-001',
        maxUses: 1,
        useCount: 0,
        isActive: false,
        createdBy: { _id: 'admin-1', username: 'admin', email: 'admin@test.com' },
      }),
    });

    await handler(req, res);

    expect(InvitationCode.findByIdAndUpdate).toHaveBeenCalledWith(
      'inv-1',
      { $set: { isActive: false } },
      { new: true },
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Invitation code revoked',
      }),
    );
  });

  it('lists waitlist requests', async () => {
    const handler = getRouteHandler('/waitlist', 'get');
    const req = { query: {} };
    const res = createRes();
    WaitlistRequest.find.mockReturnValue({
      populate: () => ({
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: () => Promise.resolve([
                  {
                    _id: 'w1',
                    email: 'wait@example.com',
                    status: 'pending',
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    });
    WaitlistRequest.countDocuments.mockResolvedValue(1);

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        limit: 20,
        totalPages: 1,
        total: 1,
        requests: [expect.objectContaining({ id: 'w1', email: 'wait@example.com' })],
      }),
    );
  });

  it('lists invitation codes with pagination metadata', async () => {
    const handler = getRouteHandler('/invitations', 'get');
    const req = { query: { page: '2', limit: '5' } };
    const res = createRes();
    InvitationCode.find.mockReturnValue({
      populate: () => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              lean: () => Promise.resolve([
                {
                  _id: 'inv-1',
                  code: 'CM-12345678',
                  maxUses: 1,
                  useCount: 0,
                  isActive: true,
                },
              ]),
            }),
          }),
        }),
      }),
    });
    InvitationCode.countDocuments.mockResolvedValue(6);

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 5,
        total: 6,
        totalPages: 2,
        invitations: [expect.objectContaining({ id: 'inv-1', code: 'CM-12345678' })],
      }),
    );
  });

  it('sends invitation email for waitlist request', async () => {
    process.env.SMTP2GO_API_KEY = 'test-key';
    process.env.SMTP2GO_FROM_EMAIL = 'support@commonly.me';
    process.env.FRONTEND_URL = 'https://app-dev.commonly.me';

    const handler = getRouteHandler('/waitlist/:requestId/send-invitation', 'post');
    const req = {
      params: { requestId: 'w1' },
      user: { id: 'admin-1' },
      body: {},
    };
    const res = createRes();

    const waitRequest = {
      _id: 'w1',
      email: 'wait@example.com',
      name: 'Wait Lister',
      status: 'pending',
      save: jest.fn().mockResolvedValue(true),
    };
    WaitlistRequest.findById
      .mockResolvedValueOnce(waitRequest)
      .mockReturnValueOnce({
        populate: () => ({
          populate: () => ({
            lean: () => Promise.resolve({
              _id: 'w1',
              email: 'wait@example.com',
              status: 'invited',
              invitationCode: { _id: 'inv-99', code: 'CM-TEST9999' },
            }),
          }),
        }),
      });
    InvitationCode.findOne.mockResolvedValue(null);
    InvitationCode.create.mockResolvedValue({
      _id: 'inv-99',
      code: 'CM-TEST9999',
    });
    axios.post.mockResolvedValue({ data: { data: { succeeded: 1 } } });

    await handler(req, res);

    expect(InvitationCode.create).toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalled();
    expect(waitRequest.save).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Invitation email sent',
    }));

    delete process.env.SMTP2GO_API_KEY;
    delete process.env.SMTP2GO_FROM_EMAIL;
    delete process.env.FRONTEND_URL;
  });
});
