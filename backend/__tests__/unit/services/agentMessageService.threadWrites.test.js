/**
 * Agents post in-thread without addressing (TASK-052's write half,
 * constraint 5: "the thread is ambient membership, the reply edge is a
 * ping").
 *
 * The pins that matter most are the failure directions: a ThreadRootError
 * must PROPAGATE (resolution runs before the PG try, because inside it the
 * error would be swallowed into the Mongo fallback and the post would land
 * silently un-threaded — the data loss the resolver exists to prevent),
 * and a thread-scoped post with no PG store must refuse loudly rather than
 * strand an unthreaded Mongo row.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const socketConfig = require('../../../config/socket');
const DMService = require('../../../services/dmService');
const PGMessage = require('../../../models/pg/Message');
const File = require('../../../models/File');
const threadRootResolver = require('../../../services/threadRootResolver');
const mockDispatch = jest.fn();

jest.mock('../../../models/Message');
jest.mock('../../../models/Summary', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
  buildAgentUsername: jest.fn((agentName, instanceId) => `${agentName}-${instanceId}`),
  syncUserToPostgreSQL: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../models/pg/Pod', () => ({
  findById: jest.fn().mockResolvedValue({ id: 'pg-pod-1' }),
}));
jest.mock('../../../services/podAssetService', () => ({
  createChatSummaryAsset: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  resolveAgentOwner: jest.fn(),
  getOrCreateAdminDMPod: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    })),
  },
}));
jest.mock('../../../models/User', () => ({
  find: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  })),
  findOne: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(null),
  })),
}));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ type: 'chat' }),
  })),
}));
jest.mock('../../../models/File', () => ({
  find: jest.fn(),
  findOne: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(null),
  })),
}));
jest.mock('../../../models/pg/Message', () => ({
  create: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../../../services/threadRootResolver', () => {
  class ThreadRootError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ThreadRootError';
      this.code = code;
    }
  }
  return { resolveThreadRoot: jest.fn(), assertReplyTargetInPod: jest.fn().mockResolvedValue(undefined), ThreadRootError };
});
jest.mock('../../../services/installable/eventHandlers', () => ({
  dispatch: (...args) => mockDispatch(...args),
}));
const mockFirstTask = jest.fn();
jest.mock('../../../services/starterTaskService', () => ({
  completeFirstTaskOnAnswer: (...args) => mockFirstTask(...args),
}));

const POD = '6a0da39bae757028b39f87a6';
let emitted;

beforeEach(() => {
  jest.clearAllMocks();
  emitted = [];
  process.env.PG_HOST = 'localhost';
  jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([]);
  AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({
    _id: 'agent-user-1',
    username: 'sprint-review',
    profilePicture: 'default',
  });
  AgentIdentityService.ensureAgentInPod.mockResolvedValue({ _id: POD });
  socketConfig.getIO.mockReturnValue({
    to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
  });
  DMService.resolveAgentOwner.mockResolvedValue(null);
  DMService.getOrCreateAdminDMPod.mockResolvedValue({ _id: 'dm-pod-1' });
  File.find.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  });
  PGMessage.create.mockResolvedValue({
    id: '57601',
    content: 'in-thread continuation',
    message_type: 'text',
    created_at: new Date('2026-08-23T00:00:00Z'),
    thread_root_id: '57577',
  });
});

afterEach(() => {
  delete process.env.PG_HOST;
  if (AgentMessageService.getRecentMessages.mockRestore) {
    AgentMessageService.getRecentMessages.mockRestore();
  }
});

describe('agent in-thread posts (threadRootId, no reply edge)', () => {
  it('resolves the root and hands it to create as the seventh argument', async () => {
    threadRootResolver.resolveThreadRoot.mockResolvedValue(57577);

    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'in-thread continuation',
      threadRootId: '57577',
    });

    expect(threadRootResolver.resolveThreadRoot).toHaveBeenCalledWith({
      podId: POD, replyToMessageId: null, threadRootId: '57577',
    });
    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 'agent-user-1', 'in-thread continuation', 'text', null, null, 57577, undefined,
    );
    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg.payload.thread_root_id).toBe('57577');
  });

  it('a plain post never touches the resolver and passes a null root', async () => {
    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'plain broadcast',
    });

    expect(threadRootResolver.resolveThreadRoot).not.toHaveBeenCalled();
    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 'agent-user-1', 'plain broadcast', 'text', null, null, null, undefined,
    );
  });

  it('marks trusted stalled-connect nudges as kernel-authored and leaves agent posts unmarked', async () => {
    PGMessage.create.mockResolvedValueOnce({
      id: '57604',
      content: 'Your agent is waiting for a connection.',
      message_type: 'text',
      author_kind: 'kernel',
      created_at: new Date('2026-08-23T00:00:00Z'),
      thread_root_id: null,
    });

    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'Your agent is waiting for a connection.',
      metadata: { kind: 'stalled-connect-nudge' },
      authorKind: 'kernel',
    });

    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 'agent-user-1', 'Your agent is waiting for a connection.', 'text', null, null, null, undefined, 'kernel',
    );
    const kernelMessage = emitted.find((entry) => entry.payload.id === '57604');
    expect(kernelMessage.payload.author_kind).toBe('kernel');

    PGMessage.create.mockResolvedValueOnce({
      id: '57605',
      content: 'I am connected now.',
      message_type: 'text',
      author_kind: null,
      created_at: new Date('2026-08-23T00:00:00Z'),
      thread_root_id: null,
    });
    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'I am connected now.',
    });

    expect(PGMessage.create).toHaveBeenLastCalledWith(
      POD, 'agent-user-1', 'I am connected now.', 'text', null, null, null, undefined,
    );
    const agentMessage = emitted.find((entry) => entry.payload.id === '57605');
    expect(agentMessage.payload.author_kind).toBeNull();
  });

  it('forwards a relay-only decision card to the outbound dispatcher without persisting it', async () => {
    const card = {
      title: 'Choose a train',
      question: 'Which rollout should ship?',
      options: [{ label: 'Canary' }, { label: 'Fast lane' }],
    };
    const content = 'Choose a train\n\nWhich rollout should ship?';
    PGMessage.create.mockResolvedValueOnce({
      id: '57602',
      content,
      message_type: 'text',
      created_at: new Date('2026-08-23T00:00:00Z'),
      thread_root_id: null,
    });

    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content,
      relayCard: card,
    });

    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 'agent-user-1', content, 'text', null, null, null, undefined,
    );
    expect(mockDispatch).toHaveBeenCalledWith('chat.message', expect.objectContaining({
      podId: POD,
      content,
      card,
    }));
  });

  // TASK-267a, Rhea on #2244: a native turn that read web results posts with
  // noOutboundRelay, and the flag must reach the relay dispatcher with the
  // stored message on every path, because the dispatcher (not the turn) is
  // where bridges are selected after the write.
  describe('noOutboundRelay reaches the relay dispatcher with the message', () => {
    const relayPayloads = () => mockDispatch.mock.calls
      .filter(([eventType]) => eventType === 'chat.message')
      .map(([, payload]) => payload);

    it('on the Postgres path, and an unflagged post carries no flag', async () => {
      PGMessage.create.mockResolvedValue({
        id: '57603', content: 'searched answer', message_type: 'text', created_at: new Date(), thread_root_id: null,
      });
      await AgentMessageService.postMessage({
        agentName: 'scout', instanceId: 'default', podId: POD, content: 'searched answer', noOutboundRelay: true,
      });
      await AgentMessageService.postMessage({
        agentName: 'scout', instanceId: 'default', podId: POD, content: 'plain answer',
      });

      const [flagged, plain] = relayPayloads();
      expect(flagged).toMatchObject({ podId: POD, noOutboundRelay: true });
      expect(plain).not.toHaveProperty('noOutboundRelay');
    });

    it('on the Mongo path', async () => {
      delete process.env.PG_HOST;
      const Message = require('../../../models/Message');
      Message.mockImplementation((doc) => ({
        ...doc,
        _id: 'mongo-message-1',
        save: jest.fn().mockResolvedValue(undefined),
        populate: jest.fn().mockResolvedValue(undefined),
        toObject() { return { ...doc, _id: 'mongo-message-1' }; },
      }));

      await AgentMessageService.postMessage({
        agentName: 'scout', instanceId: 'default', podId: POD, content: 'searched answer', noOutboundRelay: true,
      });

      expect(PGMessage.create).not.toHaveBeenCalled();
      expect(relayPayloads()).toEqual([expect.objectContaining({ podId: POD, noOutboundRelay: true })]);
    });

    it('serializes a Mongoose document before overlaying the kernel author kind', async () => {
      delete process.env.PG_HOST;
      const Message = require('../../../models/Message');
      Message.mockImplementation((doc) => {
        const persisted = { ...doc, _id: 'mongo-message-kernel' };
        return {
          $__: {},
          _doc: persisted,
          save: jest.fn().mockResolvedValue(undefined),
          populate: jest.fn().mockResolvedValue(undefined),
          toObject: jest.fn(() => persisted),
        };
      });

      await AgentMessageService.postMessage({
        agentName: 'scout', instanceId: 'default', podId: POD,
        content: 'Your agent is waiting for a connection.',
        authorKind: 'kernel',
      });

      const broadcast = emitted.find((entry) => entry.event === 'newMessage');
      expect(broadcast.payload).toMatchObject({
        _id: 'mongo-message-kernel',
        content: 'Your agent is waiting for a connection.',
        author_kind: 'kernel',
      });
    });

    it('on the error-to-DM route, for the DM post and the source notice', async () => {
      PGMessage.create.mockResolvedValue({
        id: '57604', content: 'x', message_type: 'text', created_at: new Date(), thread_root_id: null,
      });
      await AgentMessageService.routeErrorToDM({
        agentName: 'scout',
        instanceId: 'default',
        podId: POD,
        content: 'searched text that failed',
        agentUser: { _id: 'agent-user-1', username: 'scout' },
        noOutboundRelay: true,
      });

      const payloads = relayPayloads();
      expect(payloads).toHaveLength(2);
      expect(payloads.every((payload) => payload.noOutboundRelay === true)).toBe(true);
    });
  });

  // QA walk 3: "Give your agent its first task" completes on the first answer
  // an agent gives the workspace owner. Every landed agent post offers it to
  // the starter-task check, which decides; a refused post never does.
  it('offers each landed post to the first-task check, with the reply edge', async () => {
    await AgentMessageService.postMessage({
      agentName: 'lee-agent',
      instanceId: 'default',
      podId: POD,
      content: 'Done: the build is green.',
      displayName: 'Lee Agent',
      replyToMessageId: '57577',
    });
    expect(mockFirstTask).toHaveBeenCalledTimes(1);
    expect(mockFirstTask).toHaveBeenCalledWith({
      podId: POD, agentName: 'lee-agent', instanceId: 'default', replyToMessageId: '57577', agentLabel: 'Lee Agent',
      content: 'Done: the build is green.',
    });
  });

  // Since #2269 an agent a person addressed answers even when another agent won
  // the claim, so it holds none. The native run names the message it is
  // answering; it reaches both answer readers and is never a reply edge.
  it('hands answeringMessageId to the write and the first-task check, never as a reply edge', async () => {
    await AgentMessageService.postMessage({
      agentName: 'lee-agent',
      instanceId: 'default',
      podId: POD,
      content: 'Here is the summary.',
      displayName: 'Lee Agent',
      answeringMessageId: '78385',
    });
    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 'agent-user-1', 'Here is the summary.', 'text', null, null, null, '78385',
    );
    expect(mockFirstTask).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: null, answeringMessageId: '78385',
    }));
  });

  it('a ThreadRootError propagates — never swallowed into the Mongo fallback', async () => {
    threadRootResolver.resolveThreadRoot.mockRejectedValue(
      new threadRootResolver.ThreadRootError('root is in another pod', 'thread_root_other_pod'),
    );

    await expect(AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'mis-aimed continuation',
      threadRootId: '99999',
    })).rejects.toMatchObject({ name: 'ThreadRootError', code: 'thread_root_other_pod' });

    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  // TASK-278: an agent's reply to a message in another pod is refused before
  // the write, and the refusal propagates instead of falling into Mongo.
  it('refuses a reply whose target is in another pod, before anything is written', async () => {
    threadRootResolver.assertReplyTargetInPod.mockRejectedValueOnce(
      new threadRootResolver.ThreadRootError('the message being replied to is not in this pod', 'reply_target_unavailable'),
    );

    await expect(AgentMessageService.postMessage({
      agentName: 'sprint-review', instanceId: 'default', podId: POD, content: 'a reply', replyToMessageId: '500',
    })).rejects.toMatchObject({ name: 'ThreadRootError', code: 'reply_target_unavailable' });

    expect(threadRootResolver.assertReplyTargetInPod).toHaveBeenCalledWith({ podId: POD, replyToMessageId: '500' });
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('refuses a thread-scoped post without the PG store instead of stranding it in Mongo', async () => {
    delete process.env.PG_HOST;

    await expect(AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'in-thread continuation',
      threadRootId: '57577',
    })).rejects.toThrow('threadRootId posts require the PostgreSQL message store');
    // Nothing landed, so nothing is offered to the first-task check.
    expect(mockFirstTask).not.toHaveBeenCalled();
  });
});
