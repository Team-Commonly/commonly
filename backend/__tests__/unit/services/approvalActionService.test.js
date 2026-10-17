/**
 * ADR-020 D2/D3 — the approval lifecycle's load-bearing invariants:
 *  - only the owner decides; agents (isBot) never decide even as owner
 *  - one-way transitions: resolve at most once, execute at most once
 *  - expiry is advisory age (ADR-017:201): late decisions are honored and
 *    stamped decidedAfterExpiry — never refused
 *  - decline never executes
 *  - the executor creates resources owned by the USER, never the bot
 */

const mockApprovalFindById = jest.fn();
const mockApprovalFindOneAndUpdate = jest.fn();
const mockApprovalCreate = jest.fn();
jest.mock('../../../models/ApprovalAction', () => ({
  findById: (...args) => mockApprovalFindById(...args),
  findOneAndUpdate: (...args) => mockApprovalFindOneAndUpdate(...args),
  create: (...args) => mockApprovalCreate(...args),
}));

const mockPodCreate = jest.fn();
const mockPodFindById = jest.fn();
const mockPodUpdateOne = jest.fn();
jest.mock('../../../models/Pod', () => ({
  create: (...args) => mockPodCreate(...args),
  findById: (...args) => mockPodFindById(...args),
  updateOne: (...args) => mockPodUpdateOne(...args),
}));

const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findById: (...args) => mockUserFindById(...args),
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const mockInstallFindOne = jest.fn();
const mockInstallUpsert = jest.fn();
const mockRegistryGetByName = jest.fn();
const mockRegistryCreate = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => mockInstallFindOne(...args),
    findOneAndUpdate: (...args) => mockInstallUpsert(...args),
  },
  AgentRegistry: {
    getByName: (...args) => mockRegistryGetByName(...args),
    create: (...args) => mockRegistryCreate(...args),
  },
}));

const mockGetOrCreateAgentUser = jest.fn();
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: (...args) => mockGetOrCreateAgentUser(...args),
  syncUserToPostgreSQL: jest.fn(),
}));

jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
// Name reservation has its own suite (agentNameReservation); these arms use free names.
jest.mock('../../../services/agentNameReservation', () => ({ reservedAgentNameRefusal: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
// #2160: approving wakes the proposer; that path has its own suite (approvalActionService.proposerWake).
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
const mockPostMessage = jest.fn().mockResolvedValue({ id: 1 });
jest.mock('../../../services/agentMessageService', () => ({ postMessage: (...args) => mockPostMessage(...args) }));
const mockResolveAttention = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/attentionItemService', () => ({
  recordActionApproval: jest.fn().mockResolvedValue(undefined),
  resolve: (...args) => mockResolveAttention(...args),
}));

const { resolveApproval } = require('../../../services/approvalActionService');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const STRANGER = 'bbbbbbbbbbbbbbbbbbbbbbb2';

const flaggedRow = (over = {}) => ({
  _id: 'appr-1',
  podId: 'pod-1',
  messageId: 'not-numeric-mongo-id',
  ownerUserId: OWNER,
  agentName: 'guide',
  instanceId: 'udefault',
  actionType: 'create_pod',
  params: { name: 'Design Studio', type: 'chat' },
  summary: 'Create a pod for design work',
  status: 'flagged',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  podHasOutsiderWritableGrant.mockResolvedValue(false);
  delete process.env.PG_HOST;
  mockUserFindById.mockReturnValue({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ isBot: false }) })),
  });
  // Mongo card-message update path (messageId non-numeric).
  // eslint-disable-next-line global-require
  jest.mock('../../../models/Message', () => ({ updateOne: jest.fn().mockResolvedValue({}) }), { virtual: false });
});

describe('resolveApproval authorization', () => {
  test('404s on unknown approval', async () => {
    mockApprovalFindById.mockResolvedValue(null);
    const res = await resolveApproval({ approvalId: 'x', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(404);
  });

  test('403s a caller who is not the owner', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: STRANGER, decision: 'approved' });
    expect(res.status).toBe(403);
    expect(mockApprovalFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('403s a bot caller even when it is the owner — no agent may decide', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    mockUserFindById.mockReturnValue({
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ isBot: true }) })),
    });
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(403);
    expect(mockApprovalFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('resolveApproval lifecycle', () => {
  test('already-resolved returns 409 and never re-executes', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow({ status: 'resolved', decision: 'approved' }));
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(mockPodCreate).not.toHaveBeenCalled();
  });

  test('a decision past expiresAt is honored and stamped decidedAfterExpiry (ADR-017:201)', async () => {
    // Expiry is advisory age, not refusal — refusing would convert
    // fail-closed into fail-silent (the owner's explicit intent dropped
    // because a timer won). Caught as an ADR-017/ADR-020 conflict by
    // pod-architect in the 2026-08-13 fleet review; ADR-017 wins.
    const row = flaggedRow({ expiresAt: new Date(Date.now() - 1000) });
    mockApprovalFindById.mockResolvedValue(row);
    const resolved = flaggedRow({ status: 'resolved', decision: 'declined', decidedAfterExpiry: true });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'declined' });

    expect(res.status).toBe(200);
    const [, update] = mockApprovalFindOneAndUpdate.mock.calls[0];
    expect(update.$set.decidedAfterExpiry).toBe(true);
    expect(update.$set.status).toBe('resolved');
  });

  test('losing the atomic transition race returns 409 without executing', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    mockApprovalFindOneAndUpdate.mockResolvedValue(null);
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(mockPodCreate).not.toHaveBeenCalled();
  });

  test('deciding clears the inbox row for that proposal, approve and decline alike (#1650)', async () => {
    const row = flaggedRow();
    mockApprovalFindById.mockResolvedValue(row);
    mockApprovalFindOneAndUpdate.mockResolvedValue({ ...row, status: 'declined' });
    await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'declined' });
    expect(mockResolveAttention).toHaveBeenCalledWith('approval_action', 'appr-1');
  });

  test('decline resolves without executing anything', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const resolved = flaggedRow({ status: 'resolved', decision: 'declined' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'declined' });
    expect(res.status).toBe(200);
    expect(res.body.approval.decision).toBe('declined');
    expect(mockPodCreate).not.toHaveBeenCalled();
  });
});

describe('approved create_pod execution — D2: user authority owns', () => {
  test('creates the pod owned by the USER with the agent joined as member', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const resolved = flaggedRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockPodCreate.mockResolvedValue({ _id: 'newpod-1', name: 'Design Studio', type: 'chat', members: [OWNER] });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({
      displayName: 'Guide',
      scopes: ['context:read'],
      config: {
        runtime: { runtimeType: 'native' },
        wakeOnMessage: { enabled: true },
      },
      version: '1.0.0',
    }) });
    mockInstallUpsert.mockResolvedValue({});
    mockGetOrCreateAgentUser.mockResolvedValue({ _id: 'guide-bot-1' });
    mockPodUpdateOne.mockResolvedValue({});

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    // The heart of D2: createdBy is the owner, members start with the owner —
    // NEVER the bot user.
    expect(mockPodCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Design Studio',
      createdBy: OWNER,
      members: [OWNER],
      joinPolicy: 'invite-only',
    }));
    // The proposing agent joins: installation cloned + bot user pushed.
    expect(mockInstallUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'guide', podId: 'newpod-1' }),
      expect.anything(),
      expect.anything(),
    );
    // D8's wake opt-in belongs to one installation. Cloning the agent into a
    // newly approved pod must default to off rather than inherit the source
    // pod's every-message setting.
    expect(mockInstallUpsert.mock.calls[0][1].$set.config.wakeOnMessage).toBeUndefined();
    expect(mockInstallUpsert.mock.calls[0][1].$set.config.runtime).toEqual({ runtimeType: 'native' });
    expect(mockPodUpdateOne).toHaveBeenCalledWith(
      { _id: 'newpod-1', members: { $ne: 'guide-bot-1' } },
      { $push: { members: 'guide-bot-1' } },
    );
    expect(resolved.executedAt).toBeInstanceOf(Date);
    expect(resolved.executionResult).toEqual(expect.objectContaining({ podId: 'newpod-1', agentJoined: true }));
  });

  // A new pod's next steps (2026-10-15): the first message in the pod is the
  // proposer offering two buttons, server-composed the #2194 way, so a new
  // pod is one click from an agent of its own and one from a second person.
  test('posts the new pod\'s next steps as buttons: connect an agent to THIS pod, invite a teammate', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const resolved = flaggedRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockPodCreate.mockResolvedValue({ _id: 'newpod-3', name: 'vuedsfr', type: 'chat', members: [OWNER] });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ displayName: 'Scout', config: {} }) });
    mockInstallUpsert.mockResolvedValue({});
    mockGetOrCreateAgentUser.mockResolvedValue({ _id: 'guide-bot-1' });
    mockPodUpdateOne.mockResolvedValue({});

    await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const posted = mockPostMessage.mock.calls[0][0];
    expect(posted).toEqual(expect.objectContaining({ agentName: 'guide', podId: 'newpod-3', displayName: 'Scout' }));
    expect(posted.content).toMatch(/agent you already use/);
    expect(posted.content).toMatch(/invite a teammate/);
    expect(posted.payload.kind).toBe('starts');
    expect(posted.payload.starts.map(({ id }) => id)).toEqual(['connect-agent-here', 'invite-teammate']);
    const [connect, invite] = posted.payload.starts;
    expect(connect.label).toBe('Connect an agent to this pod');
    // Aimed at the NEW pod, never the pod the card was approved in.
    expect(connect.href.startsWith('/v2/agents/byo?pod=newpod-3')).toBe(true);
    expect(invite).toEqual({ id: 'invite-teammate', label: 'Invite a teammate', action: 'invite' });
    expect(resolved.executionResult).toEqual(expect.objectContaining({ nextStepsPosted: true }));
  });

  test('a failed next-steps post never fails the pod: the result says so and the decision stands', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const resolved = flaggedRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockPodCreate.mockResolvedValue({ _id: 'newpod-4', name: 'Design Studio', type: 'chat', members: [OWNER] });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ displayName: 'Scout', config: {} }) });
    mockInstallUpsert.mockResolvedValue({});
    mockGetOrCreateAgentUser.mockResolvedValue({ _id: 'guide-bot-1' });
    mockPodUpdateOne.mockResolvedValue({});
    mockPostMessage.mockRejectedValueOnce(new Error('pg down'));

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executionError).toBeUndefined();
    expect(resolved.executionResult).toEqual(expect.objectContaining({ podId: 'newpod-4', agentJoined: true, nextStepsPosted: false }));
  });

  test('agent-join failure is carried in the result, never a clean "done" (sprint-review finding)', async () => {
    // The pod is real (user owns it), but membership without an installation
    // 403s every post — a lied face here is unrecoverable because execution
    // is at-most-once. The result must carry the partial truth.
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const resolved = flaggedRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockPodCreate.mockResolvedValue({ _id: 'newpod-2', name: 'Design Studio' });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockInstallUpsert.mockRejectedValue(new Error('install collection offline'));

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executedAt).toBeInstanceOf(Date);
    expect(resolved.executionResult).toEqual(expect.objectContaining({
      podId: 'newpod-2',
      agentJoined: false,
      agentJoinError: expect.stringContaining('install collection offline'),
      nextStepsPosted: false,
    }));
    expect(resolved.executionError).toBeUndefined();
    // An agent that could not join cannot post there, so nothing is offered.
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test('execution failure keeps the decision and records the error honestly', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    const resolved = flaggedRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockPodCreate.mockRejectedValue(new Error('mongo down'));

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executionError).toContain('mongo down');
    expect(resolved.executedAt).toBeUndefined();
  });
});

describe('approved connect_local_agent execution — the seat, never the token', () => {
  const seatRow = (over = {}) => flaggedRow({
    actionType: 'connect_local_agent',
    params: { name: 'sams-claude' },
    summary: 'Set up a seat for your local Claude',
    ...over,
  });

  test('refuses a webhook seat when the pod gained an outsider-writable grant after proposal', async () => {
    podHasOutsiderWritableGrant.mockResolvedValue(true);
    mockApprovalFindById.mockResolvedValue(seatRow());
    const resolved = seatRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockInstallFindOne.mockResolvedValue(null);
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(200);
    expect(resolved.executionError).toContain('Use a separate pod');
    expect(mockRegistryCreate).not.toHaveBeenCalled();
    expect(mockInstallUpsert).not.toHaveBeenCalled();
  });

  test('creates the seat owned by the USER and hands back a connect path — no credential anywhere', async () => {
    mockApprovalFindById.mockResolvedValue(seatRow());
    const resolved = seatRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    // #609 foreign-owner probe (bare findOne), then the active-install probe.
    mockInstallFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockRegistryGetByName.mockResolvedValue(null);
    mockRegistryCreate.mockResolvedValue({ latestVersion: '1.0.0' });
    mockInstallUpsert.mockResolvedValue({});

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    // Ephemeral registry row published under the OWNER (ADR-006 self-serve).
    expect(mockRegistryCreate).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'sams-claude',
      ephemeral: true,
      publisher: { userId: OWNER },
    }));
    // Installation installedBy the OWNER with the webhook runtime.
    expect(mockInstallUpsert).toHaveBeenCalledWith(
      { agentName: 'sams-claude', podId: 'pod-1', instanceId: 'default' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'active',
          config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
        }),
        $setOnInsert: expect.objectContaining({ installedBy: OWNER }),
      }),
      expect.anything(),
    );
    expect(resolved.executionResult).toEqual(expect.objectContaining({
      agentName: 'sams-claude',
      connectPath: '/v2/agents/byo?pod=pod-1&name=sams-claude&from=card',
    }));
    // D1: the executor never mints or returns a credential — the token step
    // stays a human-in-browser act on the connect page.
    expect(JSON.stringify(resolved.executionResult)).not.toMatch(/token/i);
  });

  // QA BYO walk 2: the page re-asked what the card had settled. from=card says
  // the person chose; adapter says which tool, when the proposer asked.
  test('the connect path names the tool the proposer was told, and nothing else it was given', async () => {
    const row = seatRow({ params: { name: 'lee-codex', adapter: 'codex' } });
    mockApprovalFindById.mockResolvedValue(row);
    const resolved = seatRow({ status: 'resolved', decision: 'approved', params: row.params });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockInstallFindOne.mockResolvedValue(null);
    mockRegistryGetByName.mockResolvedValue(null);
    mockRegistryCreate.mockResolvedValue({ latestVersion: '1.0.0' });
    mockInstallUpsert.mockResolvedValue({});
    await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(resolved.executionResult.connectPath).toBe('/v2/agents/byo?pod=pod-1&name=lee-codex&from=card&adapter=codex');
  });

  test('an adapter outside the list never reaches the connect path', async () => {
    const row = seatRow({ params: { name: 'lee-codex', adapter: 'codex&mode=hosted' } });
    mockApprovalFindById.mockResolvedValue(row);
    const resolved = seatRow({ status: 'resolved', decision: 'approved', params: row.params });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockInstallFindOne.mockResolvedValue(null);
    mockRegistryGetByName.mockResolvedValue(null);
    mockRegistryCreate.mockResolvedValue({ latestVersion: '1.0.0' });
    mockInstallUpsert.mockResolvedValue({});
    await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(resolved.executionResult.connectPath).toBe('/v2/agents/byo?pod=pod-1&name=lee-codex&from=card');
  });

  test('an existing install by the same owner is success (identity continuity), not failure', async () => {
    mockApprovalFindById.mockResolvedValue(seatRow());
    const resolved = seatRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockInstallFindOne
      .mockResolvedValueOnce(null) // foreign probe
      .mockResolvedValueOnce({ installedBy: OWNER }); // active install, own
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executionResult).toEqual(expect.objectContaining({ alreadyInstalled: true }));
    expect(resolved.executionError).toBeUndefined();
    expect(mockInstallUpsert).not.toHaveBeenCalled();
  });

  test('a name that became reserved between propose and approve fails honestly and creates nothing', async () => {
    const { reservedAgentNameRefusal } = require('../../../services/agentNameReservation');
    reservedAgentNameRefusal.mockResolvedValueOnce({ code: 'agent_name_reserved', error: '"sams-claude" is the name of a built-in agent.' });
    mockApprovalFindById.mockResolvedValue(seatRow());
    const resolved = seatRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executionError).toMatch(/built-in agent/);
    expect(mockRegistryCreate).not.toHaveBeenCalled();
    expect(mockInstallUpsert).not.toHaveBeenCalled();
  });

  test('a name claimed by ANOTHER user between propose and approve fails honestly (#609 re-check)', async () => {
    mockApprovalFindById.mockResolvedValue(seatRow());
    const resolved = seatRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    mockInstallFindOne.mockResolvedValueOnce({ installedBy: STRANGER }); // foreign probe hits

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executionError).toContain('in use by another user');
    expect(mockInstallUpsert).not.toHaveBeenCalled();
  });

  test('execution refuses a foreign durable principal after its installation rows disappear', async () => {
    mockApprovalFindById.mockResolvedValue(seatRow());
    const resolved = seatRow({ status: 'resolved', decision: 'approved' });
    mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
    const User = require('../../../models/User');
    User.findOne.mockReturnValueOnce({
      select: () => ({ lean: async () => ({ botMetadata: { ownerUserId: STRANGER } }) }),
    });
    mockInstallFindOne.mockResolvedValue(null);

    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });

    expect(res.status).toBe(200);
    expect(resolved.executionError).toContain('in use by another user');
    expect(mockInstallUpsert).not.toHaveBeenCalled();
  });
});
