jest.mock('../../../services/agentIdentityService', () => ({
  syncUserToPostgreSQL: jest.fn().mockResolvedValue(undefined),
  resolveAgentDisplayLabel: jest.fn((user, fallback) => user.botMetadata?.displayName || fallback),
}));

const User = require('../../../models/User');
const userController = require('../../../controllers/userController');
const { resolveAgentDisplayLabel, syncUserToPostgreSQL } = require('../../../services/agentIdentityService');

const mockUserDoc = (fields) => ({
  ...fields,
  followers: [],
  following: [],
  followedThreads: [],
  toObject: () => fields,
});

const mockDisplayNameLookup = (result) => {
  const select = jest.fn().mockResolvedValue(result);
  const collation = jest.fn().mockReturnValue({ select });
  User.findOne = jest.fn().mockReturnValue({ collation });
  return { select, collation };
};

describe('User Controller', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getCurrentProfile', () => {
    it('returns the current user when found', async () => {
      const mockUser = mockUserDoc({ _id: 'u1', username: 'test' });
      User.findById = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValueOnce(mockUser) });
      const req = { user: { id: 'u1' } };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      await userController.getCurrentProfile(req, res);
      expect(User.findById).toHaveBeenCalledWith('u1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ _id: 'u1', username: 'test' }));
    });

    it('returns 404 when user does not exist', async () => {
      User.findById = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValueOnce(null) });
      const req = { user: { id: 'missing' } };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      await userController.getCurrentProfile(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ msg: 'User not found' });
    });
  });

  describe('updateProfile', () => {
    it('updates the profile picture of the user', async () => {
      const updatedUser = mockUserDoc({ _id: 'u1', profilePicture: '/api/uploads/newpic.png' });
      User.findByIdAndUpdate = jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValueOnce(updatedUser) });

      const req = {
        user: { id: 'u1' },
        body: { profilePicture: 'https://api-dev.commonly.me/api/uploads/newpic.png' },
      };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      await userController.updateProfile(req, res);
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'u1',
        { $set: { profilePicture: '/api/uploads/newpic.png' } },
        { new: true },
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        _id: 'u1',
        profilePicture: '/api/uploads/newpic.png',
      }));
    });

    it('updates a human display name without changing the routable username', async () => {
      const updatedUser = mockUserDoc({
        _id: 'u1', username: 'lily', displayName: 'Lily Shen', email: 'lily@example.com', verified: true,
      });
      User.findByIdAndUpdate = jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValueOnce(updatedUser) });
      mockDisplayNameLookup(null);
      const req = {
        user: { id: 'u1' },
        body: { displayName: 'Lily Shen' },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

      await userController.updateProfile(req, res);

      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'u1',
        { $set: { displayName: 'Lily Shen' } },
        { new: true },
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        displayName: 'Lily Shen', email: 'lily@example.com',
      }));
    });

    it('rejects a case-insensitive display name collision with another account', async () => {
      const collision = mockDisplayNameLookup({ _id: 'u2' });
      const req = { user: { id: 'u1' }, body: { displayName: 'LiLy' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

      await userController.updateProfile(req, res);

      expect(User.findOne).toHaveBeenCalledWith({
        _id: { $ne: 'u1' },
        $or: [
          { username: 'LiLy' },
          { displayName: 'LiLy' },
          { 'botMetadata.displayName': 'LiLy' },
        ],
      });
      expect(collision.collation).toHaveBeenCalledWith({ locale: 'en', strength: 2 });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'That name belongs to someone else here' });
      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('excludes the current account when checking a display name collision', async () => {
      const lookup = mockDisplayNameLookup(null);
      const updatedUser = mockUserDoc({ _id: 'u1', username: 'lily', displayName: 'Lily' });
      User.findByIdAndUpdate = jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValueOnce(updatedUser) });
      const req = { user: { id: 'u1' }, body: { displayName: 'Lily' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

      await userController.updateProfile(req, res);

      expect(User.findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: { $ne: 'u1' } }));
      expect(lookup.select).toHaveBeenCalledWith('_id');
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'u1',
        { $set: { displayName: 'Lily' } },
        { new: true },
      );
    });

    it('does not report a display-name save as complete when the chat mirror is unavailable', async () => {
      const updatedUser = mockUserDoc({ _id: 'u1', username: 'lily', displayName: 'Lily Shen' });
      User.findByIdAndUpdate = jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValueOnce(updatedUser) });
      mockDisplayNameLookup(null);
      syncUserToPostgreSQL.mockResolvedValueOnce(false);
      const req = { user: { id: 'u1' }, body: { displayName: 'Lily Shen' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

      await userController.updateProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('chat is catching up'),
      }));
    });
  });

  describe('getUserById', () => {
    it('returns the user when found', async () => {
      const mockUser = mockUserDoc({ _id: 'u1', username: 'test' });
      User.findById = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValueOnce(mockUser) });
      const req = { params: { id: 'u1' }, user: { id: 'viewer' } };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      await userController.getUserById(req, res);
      expect(User.findById).toHaveBeenCalledWith('u1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ _id: 'u1', username: 'test' }));
    });

    it('returns the curated display label for an agent seat', async () => {
      const mockUser = mockUserDoc({
        _id: 'u1',
        username: 'vale',
        isBot: true,
        botMetadata: { displayName: 'Vale', agentName: 'openclaw', instanceId: 'vale' },
      });
      User.findById = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValueOnce(mockUser) });
      const req = { params: { id: 'u1' }, user: { id: 'viewer' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

      await userController.getUserById(req, res);

      expect(resolveAgentDisplayLabel).toHaveBeenCalledWith(mockUser, 'vale');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        username: 'vale',
        displayName: 'Vale',
      }));
    });

    it('returns 404 if the user is not found', async () => {
      User.findById = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValueOnce(null) });
      const req = { params: { id: 'missing' }, user: { id: 'viewer' } };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      await userController.getUserById(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ msg: 'User not found' });
    });
  });
});
