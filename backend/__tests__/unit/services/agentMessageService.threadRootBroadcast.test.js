const catalogueRevision = require('../../../config/uiCardCatalogueRevision.json');
/**
 * The agent broadcast must carry `thread_root_id` (#1169's land-alongside
 * dependency, found in review).
 *
 * The PG INSERT derives the root on write (#1106, RETURNING *), but two
 * closed literals between the row and the socket dropped it: the
 * normalization literal that builds `message` from the INSERT result, and
 * the `formattedMessage` whitelist handed to `io.emit('newMessage')`. Both
 * are whitelists on purpose (absent fields vanish — see the payload/replyTo
 * comments at the emit site), so the field must be named in BOTH or an
 * agent's reply arrives over the socket root-less and renders flat until a
 * reload re-fetches the joined row.
 *
 * These execute postMessage against a mocked PG row and assert on the
 * actual emitted payload — not on source text — so a refactor that renames
 * either literal fails loudly rather than silently un-threading live agent
 * replies.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const socketConfig = require('../../../config/socket');
const DMService = require('../../../services/dmService');
const PGMessage = require('../../../models/pg/Message');
const Message = require('../../../models/Message');
const File = require('../../../models/File');

jest.mock('../../../models/Message');
jest.mock('../../../models/Summary', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
  buildAgentUsername: jest.fn((agentName, instanceId) => `${agentName}-${instanceId}`),
  // Absent from the phantom-directive harness this file copies, because that
  // suite only exercises the Mongo path. Here it is load-bearing: postMessage
  // calls it FIRST inside the PG try, so an undefined mock throws and the
  // whole suite silently tests the Mongo fallback instead of the PG literals.
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
  findByPodId: jest.fn(),
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
});

afterEach(() => {
  delete process.env.PG_HOST;
  if (AgentMessageService.getRecentMessages.mockRestore) {
    AgentMessageService.getRecentMessages.mockRestore();
  }
});

const pgRow = (over = {}) => ({
  id: '57600',
  content: 'a reply in a thread',
  message_type: 'text',
  created_at: new Date('2026-08-23T00:00:00Z'),
  thread_root_id: '57475',
  ...over,
});

describe('agent broadcast carries thread_root_id', () => {
  it('a reply row with a derived root emits that root on newMessage', async () => {
    PGMessage.create.mockResolvedValue(pgRow());
    PGMessage.findById.mockResolvedValue({ replyTo: null });

    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'a reply in a thread',
      replyToMessageId: '57475',
    });

    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg).toBeTruthy();
    expect(msg.payload.thread_root_id).toBe('57475');
    // Live viewers must get the same agent identity as the joined history row.
    expect(msg.payload.userId).toEqual(expect.objectContaining({
      _id: 'agent-user-1',
      isBot: true,
    }));
  });

  it('a non-reply row emits an explicit null root, never an absent field', async () => {
    // The frontend distinguishes "not in a thread" (null) from "server too
    // old to say" (undefined) — see threadView. An absent key silently
    // downgrades every viewer to the legacy path.
    PGMessage.create.mockResolvedValue(pgRow({ thread_root_id: null }));

    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'a broadcast, no thread',
    });

    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg).toBeTruthy();
    expect(msg.payload).toHaveProperty('thread_root_id');
    expect(msg.payload.thread_root_id).toBeNull();
  });
});

describe('a configured PostgreSQL store is the only write path (TASK-503)', () => {
  it('fails the post when the PG write throws, writing nothing to MongoDB', async () => {
    PGMessage.create.mockRejectedValue(new Error('connection terminated'));

    await expect(AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'A live agent message',
    })).rejects.toMatchObject({ code: 'MESSAGE_STORE_UNAVAILABLE', statusCode: 503 });

    expect(Message).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.event === 'newMessage')).toBeUndefined();
  });

  it('fails a group-pod post with the same 503 when the pre-write run-cap read throws', async () => {
    // The run-cap and dedupe reads run before the write. With no Mongo
    // fallback left, the read's raw driver error used to escape as a 500 whose
    // body carried the database host and port.
    AgentMessageService.getRecentMessages.mockRestore();
    PGMessage.findByPodId.mockRejectedValue(new Error('connect ECONNREFUSED 10.9.8.7:5432'));

    const failure = await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'A live agent message',
    }).catch((error) => error);

    expect(failure).toMatchObject({ code: 'MESSAGE_STORE_UNAVAILABLE', statusCode: 503 });
    expect(failure.message).not.toMatch(/10\.9\.8\.7|5432|ECONNREFUSED/);
    expect(PGMessage.findByPodId).toHaveBeenCalled();
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(Message).not.toHaveBeenCalled();
  });
});

describe('agent broadcast carries author identity', () => {
  it('preserves the bot marker through Mongo population and the socket whitelist', async () => {
    delete process.env.PG_HOST;
    const populate = jest.fn(async function populateAuthor(_path, fields) {
      this.userId = {
        _id: 'agent-user-1',
        username: 'sprint-review',
        ...(fields.split(' ').includes('isBot') ? { isBot: true } : {}),
      };
    });
    Message.mockImplementation((data) => ({
      ...data,
      _id: 'mongo-message-1',
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(undefined),
      populate,
    }));

    await AgentMessageService.postMessage({
      agentName: 'sprint-review',
      instanceId: 'default',
      podId: POD,
      content: 'A live agent message',
    });

    const msg = emitted.find((e) => e.event === 'newMessage');
    // No PG configured: a plain MongoDB row, not a pgFallback one (TASK-503).
    expect(Message).toHaveBeenCalledWith(expect.objectContaining({ content: 'A live agent message' }));
    expect(Message.mock.calls[0][0]).not.toHaveProperty('pgFallback');
    expect(msg.payload.userId).toEqual(expect.objectContaining({
      _id: 'agent-user-1',
      isBot: true,
    }));
  });
});


describe('agent UI card payload persistence and live delivery', () => {
  const payload = { ...catalogueRevision, kind: 'ui', v: 1, lang: 'openui@1', source: 'root = Text("hello")' };
  it('passes the envelope to PostgreSQL and preserves it in result and socket', async () => {
    PGMessage.create.mockResolvedValue(pgRow({ payload, content: 'UI text fallback', message_type: 'card', thread_root_id: null }));
    const result = await AgentMessageService.postMessage({
      agentName: 'sprint-review', podId: POD, content: 'UI text fallback', messageType: 'card', payload,
    });
    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 'agent-user-1', 'UI text fallback', 'card', null, payload, null, undefined,
    );
    expect(Message).not.toHaveBeenCalled();
    expect(result.message.payload).toEqual(payload);
    expect(emitted.find((e) => e.event === 'newMessage').payload).toEqual(expect.objectContaining({
      messageType: 'card', payload, content: 'UI text fallback',
    }));
  });
  it('preserves the same envelope in Mongo fallback and live delivery', async () => {
    delete process.env.PG_HOST;
    const save = jest.fn().mockResolvedValue(undefined);
    Message.mockImplementation((data) => ({
      ...data, _id: 'mongo-card-1', createdAt: new Date(), save,
      populate: jest.fn().mockResolvedValue(undefined),
    }));
    const result = await AgentMessageService.postMessage({
      agentName: 'sprint-review', podId: POD, content: 'UI text fallback', messageType: 'card', payload,
    });
    expect(Message).toHaveBeenCalledWith(expect.objectContaining({ messageType: 'card', payload }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.message.payload).toEqual(payload);
    expect(emitted.find((e) => e.event === 'newMessage').payload.payload).toEqual(payload);
  });
});
