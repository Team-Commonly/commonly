const messageController = require('../../../controllers/messageController');
const Pod = require('../../../models/Pod');
const PGMessage = require('../../../models/pg/Message');
const AgentMentionService = require('../../../services/agentMentionService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

jest.mock('../../../models/Pod');
jest.mock('../../../models/pg/Message');
jest.mock('../../../services/agentMentionService', () => ({
  enqueueMentions: jest.fn().mockResolvedValue({ enqueued: [], implicit: [], skipped: [] }),
  enqueueDmEvent: jest.fn().mockResolvedValue({ enqueued: [], skipped: [] }),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { countDocuments: jest.fn() },
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));

const socketConfig = require('../../../config/socket');

describe('messageController', () => {
  beforeEach(() => {
    AgentInstallation.countDocuments.mockResolvedValue(0);
  });

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
      AgentInstallation.countDocuments.mockResolvedValueOnce(2);
      const req = {
        params: { podId: 'p1' },
        body: { content: 'test' },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.createMessage(req, res);
      expect(res.json).toHaveBeenCalledWith({
        ...mockMessage,
        agentDelivery: {
          enqueued: 0, implicit: [], agentsInPod: 2, woken: 0,
        },
      });
      expect(AgentMentionService.enqueueMentions).toHaveBeenCalled();
      expect(AgentMentionService.enqueueDmEvent).not.toHaveBeenCalled();
    });

    it('reports mention delivery and active-agent count for a regular pod', async () => {
      const mockMessage = { id: 3, content: '@aria can you help?' };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValue(mockMessage);
      AgentMentionService.enqueueMentions.mockResolvedValueOnce({
        enqueued: ['openclaw'], implicit: [], skipped: [],
      });
      AgentInstallation.countDocuments.mockResolvedValueOnce(2);
      const req = {
        params: { podId: 'p1' },
        body: { content: '@aria can you help?', replyToMessageId: 'm1' },
        user: { id: 'u1', username: 'alice' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith(expect.objectContaining({
        replyToMessageId: 'm1',
      }));
      expect(AgentInstallation.countDocuments).toHaveBeenCalledWith({
        podId: 'p1', status: 'active',
      });
      expect(res.json).toHaveBeenCalledWith({
        ...mockMessage,
        agentDelivery: {
          enqueued: 1, implicit: [], agentsInPod: 2, woken: 0,
        },
      });
    });

    it('uses the joined PG author for a JWT-posted chat wake', async () => {
      const pgMessage = {
        id: 31,
        content: '@aria please review this',
        userId: { _id: 'u1', username: 'sam' },
      };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValue({ id: 31 });
      PGMessage.findById.mockResolvedValueOnce(pgMessage);
      const req = {
        params: { podId: 'p1' },
        body: { content: pgMessage.content },
        // JWT auth supplies the id, not the username.
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith(expect.objectContaining({
        message: pgMessage,
        username: 'sam',
      }));
    });

    it('uses the raw PG username for a JWT-posted chat wake without a joined author', async () => {
      const pgMessage = {
        id: 33,
        content: '@aria please review this',
        username: 'sam',
      };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValue({ id: 33 });
      PGMessage.findById.mockResolvedValueOnce(pgMessage);
      const req = {
        params: { podId: 'p1' },
        body: { content: pgMessage.content },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith(expect.objectContaining({
        message: pgMessage,
        username: 'sam',
      }));
    });

    it('counts wake-on-message targets so the composer hint stays truthful (#914)', async () => {
      const mockMessage = { id: 4, content: 'hello with no mention' };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValue(mockMessage);
      // The Guide's wake-on-message path: nothing mention-enqueued, one woken.
      AgentMentionService.enqueueMentions.mockResolvedValueOnce({
        enqueued: [], implicit: [], skipped: [], woken: ['guide'],
      });
      AgentInstallation.countDocuments.mockResolvedValueOnce(1);
      const req = {
        params: { podId: 'p1' },
        body: { content: 'hello with no mention' },
        user: { id: 'u1', username: 'alice' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(res.json).toHaveBeenCalledWith({
        ...mockMessage,
        agentDelivery: {
          enqueued: 0, implicit: [], agentsInPod: 1, woken: 1,
        },
      });
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
      const response = res.json.mock.calls[0][0];
      expect(response).not.toHaveProperty('agentDelivery');
      expect(AgentInstallation.countDocuments).not.toHaveBeenCalled();
    });

    it('uses the joined PG author for a JWT-posted DM wake', async () => {
      const pgMessage = {
        id: 32,
        content: 'hello from the web UI',
        userId: { _id: 'u1', username: 'sam' },
      };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'agent-room' });
      PGMessage.create.mockResolvedValue({ id: 32 });
      PGMessage.findById.mockResolvedValueOnce(pgMessage);
      const req = {
        params: { podId: 'p2' },
        body: { content: pgMessage.content },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(AgentMentionService.enqueueDmEvent).toHaveBeenCalledWith(expect.objectContaining({
        message: pgMessage,
        username: 'sam',
      }));
    });

    it.each(['agent-room', 'agent-dm'])('omits agentDelivery for %s pods', async (type) => {
      const mockMessage = { id: 4, content: 'hello dm' };
      Pod.findById.mockResolvedValue({ members: ['u1'], type });
      PGMessage.create.mockResolvedValue(mockMessage);
      const req = {
        params: { podId: 'p2' },
        body: { content: 'hello dm' },
        user: { id: 'u1', username: 'alice' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(res.json.mock.calls[0][0]).not.toHaveProperty('agentDelivery');
      expect(AgentInstallation.countDocuments).not.toHaveBeenCalled();
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
