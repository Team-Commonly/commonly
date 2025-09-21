const messageController = require('../../../controllers/messageController');
const Pod = require('../../../models/Pod');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/Pod');
jest.mock('../../../models/pg/Message');

describe('messageController', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getMessages', () => {
    it('returns 400 if podId is missing', async () => {
      const req = { params: {}, query: {}, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 if pod not found', async () => {
      Pod.findById.mockResolvedValue(null);
      const req = { params: { podId: 'p1' }, query: {}, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 401 if user not a member', async () => {
      Pod.findById.mockResolvedValue({ members: ['other-user'] });
      const req = { params: { podId: 'p1' }, query: {}, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns messages for valid member', async () => {
      const mockMessages = [{ id: 1, content: 'test' }];
      Pod.findById.mockResolvedValue({ members: ['u1'] });
      PGMessage.findByPodId.mockResolvedValue(mockMessages);
      const req = { params: { podId: 'p1' }, query: {}, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages(req, res);
      expect(res.json).toHaveBeenCalledWith(mockMessages);
    });
  });

  describe('createMessage', () => {
    it('returns 400 if podId is missing', async () => {
      const req = { params: {}, body: { content: 'test' }, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.createMessage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('creates message successfully for valid member', async () => {
      const mockMessage = { id: 1, content: 'test' };
      Pod.findById.mockResolvedValue({ members: ['u1'] });
      PGMessage.create.mockResolvedValue(mockMessage);
      const req = { 
        params: { podId: 'p1' }, 
        body: { content: 'test' }, 
        user: { id: 'u1' } 
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.createMessage(req, res);
      expect(res.json).toHaveBeenCalledWith(mockMessage);
    });
  });

  describe('deleteMessage', () => {
    it('returns 404 when message not found', async () => {
      PGMessage.findById.mockResolvedValue(null);
      const req = { params: { id: 'm1' }, userId: 'u1', user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.deleteMessage(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('deletes message successfully for message owner', async () => {
      const mockMessage = { user_id: 'u1', pod_id: 'p1' };
      PGMessage.findById.mockResolvedValue(mockMessage);
      PGMessage.delete.mockResolvedValue(true);
      const req = { params: { id: 'm1' }, userId: 'u1', user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.deleteMessage(req, res);
      expect(res.json).toHaveBeenCalledWith({ msg: 'Message deleted' });
    });
  });
});
