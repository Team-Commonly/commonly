// Tests for reactionController — covers the dual-auth path (human JWT and
// agent runtime cm_agent_* token), the membership gate that differs between
// the two, and the Socket.io fan-out. Agent reactions are first-class
// (kernel rule, see CLAUDE.md "Agent reactions" entry); this is the
// regression net so a future refactor of dualAuth / agentRuntimeAuth can't
// silently break the agent path.

jest.mock('../../../models/pg/MessageReaction', () => ({
  __esModule: true,
  default: {
    add: jest.fn().mockResolvedValue(false),
    remove: jest.fn().mockResolvedValue(undefined),
    // Raw shape from the model post-attribution wire-up: includes the
    // ordered userIds the controller hands to reactionAttributionService.
    listForMessage: jest
      .fn()
      .mockResolvedValue([
        { emoji: '👍', count: 1, mine: true, userIds: ['caller-1'] },
      ]),
  },
}));

// reactionAttributionService is a thin User-lookup decorator. We mock it
// to a deterministic decorated shape so the test stays focused on the
// controller wire-up (membership gate + socket fan-out). Per-decorator
// behavior — User resolution, displayName fallbacks — is tested
// separately in reactionAttributionService.test.js.
jest.mock('../../../services/reactionAttributionService', () => ({
  decorateReactionSummaries: jest.fn(async (summaries) =>
    summaries.map((s) => ({
      emoji: s.emoji,
      count: s.count,
      mine: s.mine,
      users: s.userIds.map((id) => ({ id, username: `u-${id}` })),
    })),
  ),
}));

jest.mock('../../../config/db-pg', () => {
  const query = jest.fn();
  return { pool: { query } };
});

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));

jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));

jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));

const reactionController = require('../../../controllers/reactionController');
const MessageReaction = require('../../../models/pg/MessageReaction').default;
const { pool } = require('../../../config/db-pg');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEventService = require('../../../services/agentEventService');
const socketConfig = require('../../../config/socket');

const buildRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const messageLookup = (podId, authorUserId = 'message-author') => ({
  rows: [{ pod_id: podId, user_id: authorUserId }], rowCount: 1,
});
const memberLookup = (hits) => ({ rows: [], rowCount: hits });

describe('reactionController.addReaction — agent runtime path', () => {
  let emitMock;

  beforeEach(() => {
    jest.clearAllMocks();
    emitMock = jest.fn();
    socketConfig.getIO.mockReturnValue({
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    });
    User.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    });
  });

  test('agent (cm_agent_*) with an active AgentInstallation can react and triggers a socket emit', async () => {
    pool.query
      // loadMessageContext
      .mockResolvedValueOnce(messageLookup('pod-xyz'));
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
    await new Promise((r) => { setImmediate(r); });
    expect(emitMock).toHaveBeenCalledWith(
      'messageReaction',
      expect.objectContaining({
        messageId: '42',
        podId: 'pod-xyz',
      }),
    );
  });

  test('agent without AgentInstallation falls back to Pod.members and still succeeds', async () => {
    pool.query.mockResolvedValueOnce(messageLookup('pod-abc'));
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
    pool.query.mockResolvedValueOnce(messageLookup('pod-foreign'));
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
      // loadMessageContext
      .mockResolvedValueOnce(messageLookup('pod-h'))
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

  test('human NOT in pg pod_members but IN mongo pod.members is still allowed (dual-DB drift, 2026-07-24)', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-drift')) // loadMessageContext
      .mockResolvedValueOnce(memberLookup(0)); // pg pod_members MISS → must fall back to Mongo
    Pod.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ members: [{ toString: () => 'human-2' }] }) }),
    });

    const req = { params: { messageId: '12' }, body: { emoji: '👍' }, user: { _id: 'human-2' } };
    const res = buildRes();

    await reactionController.addReaction(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(MessageReaction.add).toHaveBeenCalledWith('12', 'human-2', '👍');
  });

  test('human in neither pg pod_members nor mongo members → 403', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-x'))
      .mockResolvedValueOnce(memberLookup(0));
    Pod.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ members: [] }) }) });

    const req = { params: { messageId: '13' }, body: { emoji: '👍' }, user: { _id: 'stranger' } };
    const res = buildRes();

    await reactionController.addReaction(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(MessageReaction.add).not.toHaveBeenCalled();
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

  test('new human reaction to an agent message queues one unclaimable acknowledgement for its author', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-receipt', 'author-bot'))
      .mockResolvedValueOnce(memberLookup(1));
    MessageReaction.add.mockResolvedValueOnce(true);
    User.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          isBot: true,
          username: 'reviewer',
          botMetadata: { agentName: 'openclaw', instanceId: 'reviewer-seat' },
        }),
      }),
    });

    const req = {
      params: { messageId: '44' },
      body: { emoji: '👍' },
      user: { _id: 'human-reactor' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).toHaveBeenCalledWith({
      agentName: 'openclaw',
      instanceId: 'reviewer-seat',
      podId: 'pod-receipt',
      // NOT chat.mention. That type carries cap + addressedGrace since #973,
      // so a receipt typed that way let one reaction buy a capped seat two
      // extra turns — and let anyone un-cap a seat by reacting to an old
      // message of its own.
      type: 'message.posted',
      payload: expect.objectContaining({
        reactionAcknowledgement: true,
        reactedMessageId: '44',
        emoji: '👍',
        source: 'message-reaction',
        content: expect.stringContaining('acknowledgement'),
        // A HUMAN reacted here. classifyTrigger dispatches on dmKind before
        // the messageId lookup, so this resolves to 'human' — which wakes the
        // seat and resets its cascade streak. Human attention in the room is
        // exactly what that streak measures.
        dmKind: 'user-agent',
      }),
    });
    expect(AgentEventService.enqueue.mock.calls[0][0].payload).not.toHaveProperty('messageId');
  });

  test('an AGENT reaction is stamped agent-agent so reaction loops terminate', async () => {
    // The load-bearing half. Retyping alone leaves the receipt with no
    // payload.messageId, so classifyTrigger returns 'unknown' — and 'unknown'
    // is FAIL-OPEN for admission. A capped seat would still take a full turn
    // on every reaction, uncounted, and agent↔agent reaction chains would
    // ratchet instead of terminating. Caught by fable-lead against its own
    // earlier ruling, which closed the grace hole and left this one open.
    // The agent auth path checks AgentInstallation, not pg pod_members — so
    // only ONE pool.query (loadMessageContext) is consumed here. Getting this
    // wrong does not just fail this test: it leaves the shared pool.query mock
    // queue misaligned and every following test reports "Number of calls: 0".
    pool.query.mockResolvedValueOnce(messageLookup('pod-loop', 'author-bot'));
    AgentInstallation.findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'inst-loop' }),
    });
    MessageReaction.add.mockResolvedValueOnce(true);
    User.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          isBot: true,
          username: 'looper',
          botMetadata: { agentName: 'openclaw', instanceId: 'looper-seat' },
        }),
      }),
    });

    const req = {
      params: { messageId: '77' },
      body: { emoji: '🎉' },
      // agentRuntimeAuth populates req.agentUser for cm_agent_* tokens only,
      // so its presence IS the authorship answer at the call site.
      agentUser: { _id: 'agent-reactor' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.posted',
        payload: expect.objectContaining({ dmKind: 'agent-agent' }),
      }),
    );
  });

  test('derives the same instance suffix that a token-authenticated recipient polls', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-suffix', 'suffix-bot'))
      .mockResolvedValueOnce(memberLookup(1));
    MessageReaction.add.mockResolvedValueOnce(true);
    User.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          isBot: true,
          username: 'openclaw-nova',
          botMetadata: { agentName: 'openclaw' },
        }),
      }),
    });

    await reactionController.addReaction({
      params: { messageId: 'suffix-44' },
      body: { emoji: '👍' },
      user: { _id: 'human-reactor' },
    }, buildRes());
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'nova',
    }));
  });

  test('logs and skips an acknowledgement when a legacy bot has no routable agentName', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-legacy', 'legacy-bot'))
      .mockResolvedValueOnce(memberLookup(1));
    MessageReaction.add.mockResolvedValueOnce(true);
    User.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          isBot: true,
          username: 'openclaw-reviewer',
          botMetadata: { instanceId: 'reviewer' },
        }),
      }),
    });
    const warning = jest.spyOn(console, 'warn').mockImplementation();

    await reactionController.addReaction({
      params: { messageId: 'legacy-44' },
      body: { emoji: '👍' },
      user: { _id: 'human-reactor' },
    }, buildRes());
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      '[reactionController] agent acknowledgement skipped: missing botMetadata.agentName',
      'legacy-bot',
    );
    warning.mockRestore();
  });

  test('an idempotent duplicate reaction does not wake the agent a second time', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-idempotent', 'author-bot'))
      .mockResolvedValueOnce(memberLookup(1));
    MessageReaction.add.mockResolvedValueOnce(false);

    const req = {
      params: { messageId: '45' },
      body: { emoji: '👍' },
      user: { _id: 'human-reactor' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  test('a reaction to a human message does not enqueue an agent event', async () => {
    pool.query
      .mockResolvedValueOnce(messageLookup('pod-human-author', 'human-author'))
      .mockResolvedValueOnce(memberLookup(1));
    MessageReaction.add.mockResolvedValueOnce(true);
    User.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ isBot: false, username: 'human-author' }) }),
    });

    const req = {
      params: { messageId: '46' },
      body: { emoji: '🎉' },
      user: { _id: 'human-reactor' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('an agent reacting to its own message does not wake itself', async () => {
    pool.query.mockResolvedValueOnce(messageLookup('pod-self', 'bot-self'));
    AgentInstallation.findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'inst-self' }),
    });
    MessageReaction.add.mockResolvedValueOnce(true);

    const req = {
      params: { messageId: '47' },
      body: { emoji: '👀' },
      agentUser: { _id: 'bot-self' },
    };
    const res = buildRes();

    await reactionController.addReaction(req, res);
    await new Promise((r) => { setImmediate(r); });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });
});
