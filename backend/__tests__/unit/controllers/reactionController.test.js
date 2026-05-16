// Tests for reactionController — covers the dual-auth path (human JWT and
// agent runtime cm_agent_* token), the membership gate that differs between
// the two, and the Socket.io fan-out. Agent reactions are first-class
// (kernel rule, see CLAUDE.md "Agent reactions" entry); this is the
// regression net so a future refactor of dualAuth / agentRuntimeAuth can't
// silently break the agent path.

jest.mock('../../../models/pg/MessageReaction', () => ({
  __esModule: true,
  default: {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    listForMessage: jest
      .fn()
      .mockResolvedValue([{ emoji: '👍', count: 1, mine: true }]),
  },
}));

jest.mock('../../../config/db-pg', () => {
  const query = jest.fn();
  return { pool: { query } };
});

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));

jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));

const reactionController = require('../../../controllers/reactionController');
const MessageReaction = require('../../../models/pg/MessageReaction').default;
const { pool } = require('../../../config/db-pg');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const socketConfig = require('../../../config/socket');

const buildRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const podLookup = (podId) => ({ rows: [{ pod_id: podId }], rowCount: 1 });
const memberLookup = (hits) => ({ rows: [], rowCount: hits });

describe('reactionController.addReaction — agent runtime path', () => {
  let emitMock;

  beforeEach(() => {
    jest.clearAllMocks();
    emitMock = jest.fn();
    socketConfig.getIO.mockReturnValue({
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    });
  });

  test('agent (cm_agent_*) with an active AgentInstallation can react and triggers a socket emit', async () => {
    pool.query
      // loadPodIdForMessage
      .mockResolvedValueOnce(podLookup('pod-xyz'));
    AgentInstallation.findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'inst-1' }),
    });

    const req = {
      params: { messageId: '42' },
      body: { emoji: '👍' },
      agentUser: { _id: 'bot-user-1' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);

    expect(MessageReaction.add).toHaveBeenCalledWith('42', 'bot-user-1', '👍');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    );
    // Socket emit is fire-and-forget (via `void emitReactionChange(...)`);
    // await a microtask flush so the IIFE has settled before asserting.
    await new Promise((r) => setImmediate(r));
    expect(emitMock).toHaveBeenCalledWith(
      'messageReaction',
      expect.objectContaining({
        messageId: '42',
        podId: 'pod-xyz',
      }),
    );
  });

  test('agent without AgentInstallation falls back to Pod.members and still succeeds', async () => {
    pool.query.mockResolvedValueOnce(podLookup('pod-abc'));
    AgentInstallation.findOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    Pod.findById.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve({
            members: [{ userId: { toString: () => 'bot-user-2' } }],
          }),
      }),
    });

    const req = {
      params: { messageId: '7' },
      body: { emoji: '🎉' },
      agentUser: { _id: 'bot-user-2' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);

    expect(MessageReaction.add).toHaveBeenCalledWith('7', 'bot-user-2', '🎉');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('agent with neither AgentInstallation nor Pod membership is rejected 403', async () => {
    pool.query.mockResolvedValueOnce(podLookup('pod-foreign'));
    AgentInstallation.findOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    Pod.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ members: [] }),
      }),
    });

    const req = {
      params: { messageId: '9' },
      body: { emoji: '👍' },
      agentUser: { _id: 'bot-stranger' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(MessageReaction.add).not.toHaveBeenCalled();
  });

  test('human caller hits the pg pod_members path (not the AgentInstallation path)', async () => {
    pool.query
      // loadPodIdForMessage
      .mockResolvedValueOnce(podLookup('pod-h'))
      // pod_members lookup
      .mockResolvedValueOnce(memberLookup(1));

    const req = {
      params: { messageId: '11' },
      body: { emoji: '👀' },
      user: { _id: 'human-1' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);

    expect(AgentInstallation.findOne).not.toHaveBeenCalled();
    expect(MessageReaction.add).toHaveBeenCalledWith('11', 'human-1', '👀');
  });

  test('unauthenticated request (no user, no agentUser) → 401', async () => {
    const req = { params: { messageId: '1' }, body: { emoji: '👍' } };
    const res = buildRes();
    await reactionController.addReaction(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('bad emoji shape (more than 8 chars / non-emoji) → 400', async () => {
    const req = {
      params: { messageId: '1' },
      body: { emoji: 'not-an-emoji-string' },
      agentUser: { _id: 'b1' },
    };
    const res = buildRes();
    await reactionController.addReaction(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
