/**
 * D245: an agent post's optional summary and kind reach the message store and
 * the live broadcast, and their problems come back as warnings, never as a
 * refused post. (Harness copied from agentMessageService.threadWrites.)
 */

const AgentMessageService = require('../../../services/agentMessageService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const socketConfig = require('../../../config/socket');
const DMService = require('../../../services/dmService');
const PGMessage = require('../../../models/pg/Message');
const Message = require('../../../models/Message');
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

describe('message contract on an agent post (D245)', () => {
  const post = (extra) => AgentMessageService.postMessage({
    agentName: 'sprint-review', instanceId: 'default', podId: POD, content: 'Fixed the redirect.', ...extra,
  });

  it('hands the normalized summary and kind to the store and the broadcast', async () => {
    PGMessage.create.mockResolvedValue({
      id: '57602',
      content: 'Fixed the redirect.',
      message_type: 'text',
      created_at: new Date('2026-11-04T00:00:00Z'),
      summary: 'Fixed it',
      kind: 'result',
    });
    const result = await post({ summary: ' Fixed it ', kind: 'RESULT' });

    expect(PGMessage.create).toHaveBeenCalledWith(
      POD, 
      'agent-user-1', 
      'Fixed the redirect.', 
      'text', 
      null, 
      null, 
      null, 
      undefined, 
      null,
      { summary: 'Fixed it', kind: 'result' },
    );
    expect(result.warnings).toBeUndefined();
    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg.payload).toMatchObject({ summary: 'Fixed it', kind: 'result' });
  });

  it('posts anyway and returns warnings when the contract is wrong', async () => {
    const result = await post({ summary: 'a'.repeat(140), kind: 'reasoning' });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toEqual(['summary_truncated', 'kind_unknown']);
    const contract = PGMessage.create.mock.calls[0][9];
    expect(contract).toEqual({ summary: 'a'.repeat(120), kind: null });
  });

  it('stores a self-reported receipt beside the post and broadcasts it (D245 item 4)', async () => {
    const receipt = {
      adapter: 'claude', model: 'claude-opus-5-5', turns: 2, tools: ['Read'], durationMs: 9000,
    };
    PGMessage.create.mockResolvedValue({
      id: '57603', content: 'Fixed the redirect.', message_type: 'text', created_at: new Date(),
    });
    const result = await post({ receipt });

    expect(result.warnings).toBeUndefined();
    expect(PGMessage.create.mock.calls[0][9]).toEqual({
      summary: null, kind: null, receipt: { ...receipt, source: 'self-reported' },
    });
    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg.payload.receipt).toEqual({ ...receipt, source: 'self-reported' });
  });

  it('a bad receipt posts anyway, its warnings joining the contract warnings', async () => {
    const result = await post({ kind: 'reasoning', receipt: 'claude' });

    expect(result.success).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['kind_unknown', 'receipt_not_object']);
    expect(PGMessage.create).toHaveBeenCalledWith(POD, 'agent-user-1', 'Fixed the redirect.', 'text', null, null, null, undefined);
  });

  it('with no Postgres, the Mongo document carries the receipt', async () => {
    delete process.env.PG_HOST;
    let constructed;
    Message.mockImplementation((data) => {
      constructed = data;
      return {
        ...data, _id: 'mongo-message-3', createdAt: new Date(), save: jest.fn(), populate: jest.fn(),
      };
    });

    await post({ receipt: { adapter: 'codex' } });

    expect(constructed.receipt).toEqual({ adapter: 'codex', source: 'self-reported' });
  });

  it('a post without the contract runs the old create call, unchanged', async () => {
    await post({});
    expect(PGMessage.create).toHaveBeenCalledWith(POD, 'agent-user-1', 'Fixed the redirect.', 'text', null, null, null, undefined);
    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg.payload).not.toHaveProperty('summary');
  });

  it('with no Postgres, the Mongo document and the broadcast carry the contract', async () => {
    delete process.env.PG_HOST;
    let constructed;
    Message.mockImplementation((data) => {
      constructed = data;
      return {
        ...data,
        _id: 'mongo-message-1',
        createdAt: new Date(),
        save: jest.fn().mockResolvedValue(undefined),
        populate: jest.fn().mockResolvedValue(undefined),
      };
    });

    const result = await post({ summary: 'Fixed it', kind: 'result' });

    expect(result.success).toBe(true);
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(constructed).toMatchObject({ summary: 'Fixed it', kind: 'result' });
    const msg = emitted.find((e) => e.event === 'newMessage');
    expect(msg.payload).toMatchObject({ summary: 'Fixed it', kind: 'result' });
  });

  it('with no Postgres, a post without the contract writes neither field', async () => {
    delete process.env.PG_HOST;
    let constructed;
    Message.mockImplementation((data) => {
      constructed = data;
      return {
        ...data, _id: 'mongo-message-2', createdAt: new Date(), save: jest.fn(), populate: jest.fn(),
      };
    });

    await post({});

    expect(constructed).not.toHaveProperty('summary');
    expect(constructed).not.toHaveProperty('kind');
  });

  it('a summary that is only a sentinel is dropped, and the content still posts', async () => {
    const result = await post({ summary: 'NO_REPLY', kind: 'fyi' });
    expect(result.success).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['summary_empty']);
    expect(PGMessage.create.mock.calls[0][9]).toEqual({ summary: null, kind: 'fyi' });
  });
});
