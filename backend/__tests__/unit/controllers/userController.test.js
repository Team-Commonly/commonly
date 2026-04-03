jest.mock('../../../services/agentIdentityService', () => ({
  syncUserToPostgreSQL: jest.fn().mockResolvedValue(undefined),
}));

const User = require('../../../models/User');
const userController = require('../../../controllers/userController');

const mockUserDoc = (fields) => ({
  ...fields,
  followers: [],
  following: [],
  followedThreads: [],
  toObject: () => fields,
});

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
      const updatedUser = mockUserDoc({ _id: 'u1', profilePicture: 'newpic' });
      User.findByIdAndUpdate = jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValueOnce(updatedUser) });

      const req = { user: { id: 'u1' }, body: { profilePicture: 'newpic' } };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      await userController.updateProfile(req, res);
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'u1',
        { $set: { profilePicture: 'newpic' } },
        { new: true },
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ _id: 'u1', profilePicture: 'newpic' }));
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
