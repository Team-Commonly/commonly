const messageController = require('../../../controllers/messageController');
const Pod = require('../../../models/Pod');
const MongoMessage = require('../../../models/Message');
const PGMessage = require('../../../models/pg/Message');
const AgentMentionService = require('../../../services/agentMentionService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Message', () => ({
  create: jest.fn(),
  findById: jest.fn(),
  find: jest.fn(),
}));
jest.mock('../../../models/pg/Message');
jest.mock('../../../services/agentMentionService', () => {
  const { isAutoRoutedDmPod } = jest.requireActual('../../../services/agentMentionService');
  return {
    enqueueMentions: jest.fn().mockResolvedValue({ enqueued: [], implicit: [], skipped: [] }),
    enqueueDmEvent: jest.fn().mockResolvedValue({ enqueued: [], skipped: [] }),
    isAutoRoutedDmPod,
  };
});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { countDocuments: jest.fn() },
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));
jest.mock('../../../services/threadRootResolver', () => ({
  resolveThreadRoot: jest.fn(),
  assertReplyTargetInPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/onboardingMarks', () => ({ markPodOpened: jest.fn(), markStartPicked: jest.fn() }));
const { markPodOpened, markStartPicked } = require('../../../services/onboardingMarks');
// The gate's own rules are pinned in services/welcomeHostedStart.test.js; here,
// that every page served goes through it. Pass-through unless a test says so.
jest.mock('../../../services/welcomeHostedStart', () => ({
  gateWelcomeHostedActions: jest.fn(async (messages) => messages),
}));
const { gateWelcomeHostedActions } = require('../../../services/welcomeHostedStart');

const socketConfig = require('../../../config/socket');
const { resolveThreadRoot, assertReplyTargetInPod } = require('../../../services/threadRootResolver');

describe('messageController', () => {
  beforeEach(() => {
    AgentInstallation.countDocuments.mockResolvedValue(0);
    // The reply-rejection mutation control deliberately prepares a Mongo
    // fallback that the correct path must not consume. Reset these two mocks
    // so that unused one-shot values cannot leak into the next case.
    MongoMessage.create.mockReset();
    MongoMessage.findById.mockReset();
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

    // TASK-290: the welcome's in-place hosted start is decided by its author,
    // server-side, on the page as served, on both stores.
    it('serves every page through the welcome start gate, for this pod and reader', async () => {
      const page = [{ id: 41, user_id: 'bot-1', payload: { kind: 'starts', starts: [] } }];
      const gated = [{ id: 41, gated: true }];
      Pod.findById.mockResolvedValue({ members: ['u1'] });
      PGMessage.findByPodId.mockResolvedValue(page);
      gateWelcomeHostedActions.mockResolvedValueOnce(gated);
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages({ params: { podId: 'p1' }, query: {}, user: { id: 'u1' } }, res);
      expect(gateWelcomeHostedActions).toHaveBeenCalledWith(page, 'p1', 'u1');
      expect(res.json).toHaveBeenCalledWith(gated);

      // The Mongo fallback serves through the same gate.
      PGMessage.findByPodId.mockRejectedValue(new Error('pg down'));
      MongoMessage.find.mockReturnValue({
        populate: () => ({ sort: () => ({ limit: async () => [] }) }),
      });
      gateWelcomeHostedActions.mockResolvedValueOnce(gated);
      const fallback = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages({ params: { podId: 'p1' }, query: {}, user: { id: 'u1' } }, fallback);
      expect(gateWelcomeHostedActions).toHaveBeenLastCalledWith([], 'p1', 'u1');
      expect(fallback.json).toHaveBeenCalledWith(gated);
    });

    it('marks a first look at the pod only on the first page, after access is granted', async () => {
      const pod = { members: ['u1'], createdBy: 'u1' };
      Pod.findById.mockResolvedValue(pod);
      PGMessage.findByPodId.mockResolvedValue([]);
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.getMessages({ params: { podId: 'p1' }, query: {}, user: { id: 'u1' } }, res);
      expect(markPodOpened).toHaveBeenCalledWith('u1', pod);

      markPodOpened.mockClear();
      await messageController.getMessages({ params: { podId: 'p1' }, query: { before: '2026-10-14T00:00:00Z' }, user: { id: 'u1' } }, res);
      expect(markPodOpened).not.toHaveBeenCalled();
    });

    it('does not mark anything for someone who cannot view the pod', async () => {
      Pod.findById.mockResolvedValue({ members: ['other-user'], createdBy: 'other-user' });
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.getMessages({ params: { podId: 'p1' }, query: {}, user: { id: 'u1' } }, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(markPodOpened).not.toHaveBeenCalled();
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

    // TASK-278 (Cofounder's security read): a reply's target must be in the
    // reply's pod, or this pod's preview shows another pod's message.
    it('refuses a reply whose target is in another pod, before anything is written', async () => {
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      const err = Object.assign(new Error('the message being replied to is not in this pod'), {
        name: 'ThreadRootError', code: 'reply_target_unavailable',
      });
      assertReplyTargetInPod.mockRejectedValueOnce(err);
      const req = { params: { podId: 'p1' }, body: { content: 'a reply', replyToMessageId: '500' }, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(assertReplyTargetInPod).toHaveBeenCalledWith({ podId: 'p1', replyToMessageId: '500' });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'the message being replied to is not in this pod', code: 'reply_target_unavailable',
      });
      expect(PGMessage.create).not.toHaveBeenCalled();
      expect(AgentMentionService.enqueueMentions).not.toHaveBeenCalled();
    });

    it('a store failure in that check is left to the write, which answers it', async () => {
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      assertReplyTargetInPod.mockRejectedValueOnce(new Error('PostgreSQL unavailable'));
      PGMessage.create.mockResolvedValueOnce({ id: 'pg-9', content: 'a reply' });
      PGMessage.findById.mockResolvedValueOnce({ id: 'pg-9', content: 'a reply' });
      const req = { params: { podId: 'p1' }, body: { content: 'a reply', replyToMessageId: '100' }, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(PGMessage.create).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('rejects a reply when PostgreSQL is unavailable instead of silently dropping its parent edge', async () => {
      const unsafeFallbackRow = {
        _id: { toString: () => 'mongo-reply' },
        podId: { toString: () => 'p1' },
        userId: { toString: () => 'u1' },
        content: 'a reply',
        messageType: 'text',
      };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockRejectedValueOnce(new Error('PostgreSQL unavailable'));
      // If the guard is removed, this is the real-looking Mongo row the old
      // fallback would return; the test must then fail rather than masking the
      // silent data loss behind a mock error.
      MongoMessage.create.mockResolvedValueOnce(unsafeFallbackRow);
      MongoMessage.findById.mockReturnValueOnce({
        populate: jest.fn().mockResolvedValue(unsafeFallbackRow),
      });
      const req = {
        params: { podId: 'p1' },
        body: { content: 'a reply', replyToMessageId: 'parent-1' },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Replies are temporarily unavailable. Please try again shortly.',
        code: 'REPLY_REQUIRES_POSTGRES',
      });
      expect(MongoMessage.create).not.toHaveBeenCalled();
      expect(AgentMentionService.enqueueMentions).not.toHaveBeenCalled();
    });

    it('hands every sent message to the start-pick mark with the sender and the pod', async () => {
      const pod = { members: ['u1'], type: 'chat', createdBy: 'u1' };
      Pod.findById.mockResolvedValue(pod);
      PGMessage.create.mockResolvedValueOnce({ id: 'pg-1', content: 'Start a pod for a project' });
      PGMessage.findById.mockResolvedValueOnce({ id: 'pg-1', content: 'Start a pod for a project' });
      const req = { params: { podId: 'p1' }, body: { content: 'Start a pod for a project' }, user: { id: 'u1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(res.json).toHaveBeenCalled();
      expect(markStartPicked).toHaveBeenCalledWith('u1', pod, 'Start a pod for a project');
    });

    it('does not reject or duplicate a reply when PG INSERT succeeded but its post-write read fails', async () => {
      const createdReply = { id: 'pg-reply', content: 'a reply' };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockResolvedValueOnce(createdReply);
      PGMessage.findById.mockRejectedValueOnce(new Error('PostgreSQL read unavailable'));
      const req = {
        params: { podId: 'p1' },
        body: { content: createdReply.content, replyToMessageId: 'parent-1' },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(MongoMessage.create).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        id: createdReply.id, content: createdReply.content,
      }));
    });

    it('keeps the Mongo availability fallback for a non-reply when PostgreSQL is unavailable', async () => {
      const mongoFallbackRow = {
        _id: { toString: () => 'mongo-message' },
        podId: { toString: () => 'p1' },
        userId: {
          _id: { toString: () => 'u1' }, username: 'alice', profilePicture: 'default',
        },
        content: 'ordinary message',
        messageType: 'text',
      };
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      PGMessage.create.mockRejectedValueOnce(new Error('PostgreSQL unavailable'));
      MongoMessage.create.mockResolvedValueOnce(mongoFallbackRow);
      MongoMessage.findById.mockReturnValueOnce({
        populate: jest.fn().mockResolvedValue(mongoFallbackRow),
      });
      const req = {
        params: { podId: 'p1' },
        body: { content: mongoFallbackRow.content },
        user: { id: 'u1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await messageController.createMessage(req, res);

      expect(MongoMessage.create).toHaveBeenCalledWith({
        podId: 'p1', userId: 'u1', content: mongoFallbackRow.content, messageType: 'text',
      });
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        id: 'mongo-message', content: mongoFallbackRow.content,
      }));
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

    // #646's lesson one field over (Sam's live repro 2026-08-24): without
    // thread_root_id on the broadcast, every live viewer rendered an
    // in-thread reply as a TOP-LEVEL message until refresh, and open
    // threads never updated live. The agent path (#1175) carries it; the
    // human path was the gap.
    it('broadcasts thread_root_id on the newMessage socket emit', async () => {
      Pod.findById.mockResolvedValue({ members: ['u1'], type: 'chat' });
      resolveThreadRoot.mockResolvedValue(57577);
      PGMessage.create.mockResolvedValue({ id: 'm10' });
      PGMessage.findById.mockResolvedValue({
        id: 'm10', content: 'thread detail', thread_root_id: 57577, reply_to_message_id: null,
      });
      const emit = jest.fn();
      socketConfig.getIO.mockReturnValue({ to: jest.fn(() => ({ emit })) });

      const req = {
        params: { podId: 'p1' },
        body: { content: 'thread detail', threadRootId: '57577' },
        user: { id: 'u1', username: 'alice' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await messageController.createMessage(req, res);

      expect(emit).toHaveBeenCalledWith('newMessage', expect.objectContaining({
        thread_root_id: 57577,
      }));
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
