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
