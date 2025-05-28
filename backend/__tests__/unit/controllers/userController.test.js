const User = require('../../../models/User');
const userController = require('../../../controllers/userController');

describe('User Controller', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getCurrentProfile', () => {
    it('returns the current user when found', async () => {
      const mockUser = { _id: 'u1', username: 'test' };
      const mockSelect = jest.fn().mockResolvedValueOnce(mockUser);
      User.findById = jest.fn().mockReturnValue({ select: mockSelect });
      const req = { user: { id: 'u1' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
      await userController.getCurrentProfile(req, res);
      expect(User.findById).toHaveBeenCalledWith('u1');
      expect(res.json).toHaveBeenCalledWith(mockUser);
    });

    it('returns 404 when user does not exist', async () => {
      const mockSelect = jest.fn().mockResolvedValueOnce(null);
      User.findById = jest.fn().mockReturnValue({ select: mockSelect });
      const req = { user: { id: 'missing' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
      await userController.getCurrentProfile(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ msg: 'User not found' });
    });
  });

  describe('updateProfile', () => {
    it('updates the profile picture of the user', async () => {
      const updatedUser = { _id: 'u1', profilePicture: 'newpic' };
      const mockSelect = jest.fn().mockResolvedValueOnce(updatedUser);
      User.findByIdAndUpdate = jest.fn().mockReturnValue({ select: mockSelect });

      const req = { user: { id: 'u1' }, body: { profilePicture: 'newpic' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
      await userController.updateProfile(req, res);
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'u1',
        { $set: { profilePicture: 'newpic' } },
        { new: true },
      );
      expect(res.json).toHaveBeenCalledWith(updatedUser);
    });
  });

  describe('getUserById', () => {
    it('returns the user when found', async () => {
      const mockUser = { _id: 'u1', username: 'test' };
      const mockSelect = jest.fn().mockResolvedValueOnce(mockUser);
      User.findById = jest.fn().mockReturnValue({ select: mockSelect });
      const req = { params: { id: 'u1' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
      await userController.getUserById(req, res);
      expect(User.findById).toHaveBeenCalledWith('u1');
      expect(res.json).toHaveBeenCalledWith(mockUser);
    });

    it('returns 404 if the user is not found', async () => {
      const mockSelect = jest.fn().mockResolvedValueOnce(null);
      User.findById = jest.fn().mockReturnValue({ select: mockSelect });
      const req = { params: { id: 'missing' } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
      await userController.getUserById(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ msg: 'User not found' });
    });
  });
});
