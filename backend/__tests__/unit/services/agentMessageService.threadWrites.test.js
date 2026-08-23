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
  return { resolveThreadRoot: jest.fn(), ThreadRootError };
});

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
      POD, 'agent-user-1', 'in-thread continuation', 'text', null, null, 57577,
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
      POD, 'agent-user-1', 'plain broadcast', 'text', null, null, null,
    );
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

  it('refuses a thread-scoped post without the PG store instead of stranding it in Mongo', async () => {
    delete process.env.PG_HOST;

    await expect(AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'in-thread continuation',
      threadRootId: '57577',
    })).rejects.toThrow('threadRootId posts require the PostgreSQL message store');
  });
});
