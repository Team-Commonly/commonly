const messageController = require('../../../controllers/messageController');
const Pod = require('../../../models/Pod');
const PGMessage = require('../../../models/pg/Message');
const AgentMentionService = require('../../../services/agentMentionService');

jest.mock('../../../models/Pod');
jest.mock('../../../models/pg/Message');
jest.mock('../../../services/agentMentionService', () => ({
  enqueueMentions: jest.fn().mockResolvedValue({ enqueued: [], skipped: [] }),
  enqueueDmEvent: jest.fn().mockResolvedValue({ enqueued: [], skipped: [] }),
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));

const socketConfig = require('../../../config/socket');

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
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValue(mockMessage);
      const req = {
        params: { podId: 'p1' },
        body: { content: 'test' },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.createMessage(req, res);
      expect(res.json).toHaveBeenCalledWith(mockMessage);
      expect(AgentMentionService.enqueueMentions).toHaveBeenCalled();
      expect(AgentMentionService.enqueueDmEvent).not.toHaveBeenCalled();
    });

    it('enqueues dm.message events for agent-admin pods', async () => {
      const mockMessage = { id: 2, content: 'hello dm' };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'agent-admin' });
      PGMessage.create.mockResolvedValue(mockMessage);
      const req = {
        params: { podId: 'p2' },
        body: { content: 'hello dm' },
        user: { id: 'u1', username: 'alice' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(AgentMentionService.enqueueDmEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          podId: 'p2',
          message: mockMessage,
          userId: 'u1',
        }),
      );
    });

    // #646: the newMessage broadcast dropped replyTo, so live viewers saw
    // replies without their quoted context until a reload re-fetched the
    // joined row.
    it('broadcasts replyTo on the newMessage socket emit', async () => {
      const replyTo = {
        id: 'm1', content: 'original message', username: 'bob', userId: 'u2',
      };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValue({ id: 'm9' });
      PGMessage.findById.mockResolvedValue({ id: 'm9', content: 'a reply', replyTo });
      const emit = jest.fn();
      socketConfig.getIO.mockReturnValue({ to: jest.fn(() => ({ emit })) });

      const req = {
        params: { podId: 'p1' },
        body: { content: 'a reply', replyToMessageId: 'm1' },
        user: { id: 'u1', username: 'alice' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.createMessage(req, res);

      expect(emit).toHaveBeenCalledWith('newMessage', expect.objectContaining({ replyTo }));
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
