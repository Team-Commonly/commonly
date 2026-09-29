const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockUser = { findById: jest.fn() };
const mockToolCall = { create: jest.fn(), digestArgs: (args) => `digest:${JSON.stringify(args || {})}` };
const mockReserveBudgetLineage = jest.fn().mockResolvedValue(true);
const mockDmService = { getOrCreateAgentRoom: jest.fn() };
jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/User', () => ({ __esModule: true, default: mockUser }));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true, default: mockToolCall,
  digestArgs: mockToolCall.digestArgs,
  reserveBudgetLineage: mockReserveBudgetLineage,
}));
jest.mock('../../../services/githubAppService', () => ({
  createIssue: jest.fn().mockResolvedValue({ number: 1, title: 'x', html_url: 'https://github.com/x/y/1' }),
  closeIssue: jest.fn(),
  getPullRequest: jest.fn(),
  mergePullRequest: jest.fn(),
}));
const mockProposeAction = jest.fn();
jest.mock('../../../services/approvalActionService', () => ({ proposeAction: (...args) => mockProposeAction(...args) }));
jest.mock('../../../services/dmService', () => mockDmService);
// The seat's own declaration is judged inside `callTool`/`listToolsForGrant`
// (TASK-175). This suite has no Mongo, so the RESOLUTION is mocked here and the
// resolution itself is witnessed on memory Mongo in
// `seatGrantConfinement.test.js` — this file witnesses where the check sits.
const mockSeatConfinement = jest.fn();
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: (...args) => mockSeatConfinement(...args),
}));
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400, details) {
      super(message); this.code = code; this.statusCode = statusCode; this.details = details;
    }
  }
  return {
    RoomGrantError: MockRoomGrantError,
    assertGrantUsable: jest.fn(async (options) => {
      if (options.grant.revokedAt) throw new MockRoomGrantError('grant_revoked', 'revoked', 403);
      if (!options.currentMemberIds.includes(options.agentUserId)) throw new MockRoomGrantError('not_in_audience', 'no', 403);
    }),
    getGrantLineage: jest.fn(async (grant) => [grant]),
  };
});

const broker = require('../../../services/toolBrokerService');

// Both models write `createdAt` (timestamps: true) and the broker compares it
// against the resolved row's, so the fixtures carry the fields a real row has;
// the row always predates the grant minted for it (TASK-148).
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');
const ROW_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

const grant = (overrides = {}) => ({
  grantId: 'grant-1', connectionId: 'connection-1', installationId: 'install-1',
  target: { kind: 'seat', id: 'agent-1' }, tools: ['github.create_issue'], writeMode: 'write',
  audience: ['agent-1'], expiresAt: new Date(Date.now() + 60000), createdAt: GRANT_CREATED_AT,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSeatConfinement.mockResolvedValue({ refusal: null, scope: 'unbound' });
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockRoomGrant.findOne.mockResolvedValue(grant());
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected', createdBy: 'owner-1',
    createdAt: ROW_CREATED_AT,
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockProposeAction.mockResolvedValue({ ok: true, approvalId: 'approval-1' });
  mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned: false }) }) });
  mockDmService.getOrCreateAgentRoom.mockResolvedValue({ _id: 'room-1' });
});

test('records a refusal when the approval proposal is refused, naming the owner', async () => {
  // The `{ ok: false }` branch was unexercised until the trail column needed it:
  // it is a refusal record of its own, distinct from the throwing branch above.
  mockProposeAction.mockResolvedValue({ ok: false });
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue', args: { title: 'hello' },
  })).rejects.toMatchObject({ code: 'approval_unavailable' });
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'approval_unavailable', credentialOwnerId: 'owner-1',
  }));
  expect(mockToolCall.create).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending_approval' }));
});

test('routes a parked call with the seat installation identity', async () => {
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', agentName: 'openclaw', instanceId: 'aria',
    tool: 'github.create_issue', args: { title: 'hello' },
  })).rejects.toMatchObject({ code: 'approval_required' });
  expect(mockDmService.getOrCreateAgentRoom).toHaveBeenCalledWith(
    'agent-1', 'owner-1', { agentName: 'openclaw', instanceId: 'aria' },
  );
  expect(mockProposeAction).toHaveBeenCalledWith(expect.objectContaining({
    podId: 'room-1', agentName: 'openclaw', instanceId: 'aria',
  }));
});

test('the record of an executed approval names the credential owner', async () => {
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1',
    agentUserId: 'agent-1',
    tool: 'github.create_issue',
    args: { title: 'hello', owner: 'Team-Commonly', repo: 'commonly' },
    expectedArgsDigest: 'digest:{"title":"hello","owner":"Team-Commonly","repo":"commonly"}',
    approvalId: 'approval-1',
  })).resolves.toEqual(expect.objectContaining({ callId: expect.any(String) }));
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'ok',
    approvalId: 'approval-1',
    credentialOwnerId: 'owner-1',
  }));
});

test('parks an irreversible broker call in an owner-bound approval envelope', async () => {
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue', args: { title: 'hello' },
  })).rejects.toMatchObject({ code: 'approval_required', details: { approvalId: 'approval-1' } });
  expect(mockProposeAction).toHaveBeenCalledWith(expect.objectContaining({
    ownerUserId: 'owner-1', actionType: 'tool_call', params: {},
    toolCall: expect.objectContaining({ grantId: 'grant-1', tool: 'github.create_issue' }),
  }));
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'pending_approval',
    approvalId: 'approval-1',
    credentialOwnerId: 'owner-1',
  }));
});

test('records a refusal when the approval proposal throws', async () => {
  mockProposeAction.mockRejectedValue(new Error('approval store unavailable'));
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue', args: { title: 'hello' },
  })).rejects.toMatchObject({
    code: 'approval_unavailable',
    details: { recorded: true },
  });
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'approval_unavailable',
  }));
  expect(mockToolCall.create).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending_approval' }));
});

test('refuses execution when the stored args digest does not match', async () => {
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue',
    args: { title: 'changed' }, expectedArgsDigest: 'wrong', approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'args_digest_mismatch' });
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', reason: 'args_digest_mismatch', approvalId: 'approval-1' }));
});

test('does not execute if the grant was revoked between propose and approve', async () => {
  mockRoomGrant.findOne.mockResolvedValue(grant({ revokedAt: new Date() }));
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue',
    args: { title: 'hello' }, expectedArgsDigest: 'digest:{"title":"hello"}', approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'grant_revoked' });
});

test('does not execute if the budget was exhausted between propose and approve', async () => {
  mockRoomGrant.findOne.mockResolvedValue(grant({ budget: { calls: 1 } }));
  mockReserveBudgetLineage.mockResolvedValue(false);
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue',
    args: { title: 'hello', owner: 'Team-Commonly', repo: 'commonly' },
    expectedArgsDigest: 'digest:{"title":"hello","owner":"Team-Commonly","repo":"commonly"}', approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'budget_exhausted' });
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused',
    reason: 'budget_exhausted',
    approvalId: 'approval-1',
    // The approved execution resolves the connection itself, so its record names
    // the owner (plan §8) even on a refusal after the resolution.
    credentialOwnerId: 'owner-1',
  }));
  expect(mockReserveBudgetLineage).toHaveBeenCalled();
});

test('does not execute if the owner was suspended between propose and approve', async () => {
  // TASK-181, on the path where it matters most: an approval parked while the
  // person was in good standing, and a ban applied before anyone ruled. The
  // decision is a human act, but the AUTHORITY is still the suspended owner's,
  // and the broker resolves the connection again before spending it.
  const OWNER = '6a8f6de2a1dccf2e02f31459';
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app',
    status: 'connected',
    createdBy: OWNER,
    createdAt: ROW_CREATED_AT,
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned: true }) }) });

  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1',
    agentUserId: 'agent-1',
    tool: 'github.create_issue',
    args: { title: 'hello', owner: 'Team-Commonly', repo: 'commonly' },
    expectedArgsDigest: 'digest:{"title":"hello","owner":"Team-Commonly","repo":"commonly"}',
    approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'connection_owner_banned', statusCode: 403 });
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused',
    reason: 'connection_owner_banned',
    approvalId: 'approval-1',
  }));
});

test('executes the approved call when the owner is in good standing', async () => {
  const OWNER = '6a8f6de2a1dccf2e02f31459';
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app',
    status: 'connected',
    createdBy: OWNER,
    createdAt: ROW_CREATED_AT,
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned: false }) }) });

  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1',
    agentUserId: 'agent-1',
    tool: 'github.create_issue',
    args: { title: 'hello', owner: 'Team-Commonly', repo: 'commonly' },
    expectedArgsDigest: 'digest:{"title":"hello","owner":"Team-Commonly","repo":"commonly"}',
    approvalId: 'approval-1',
  })).resolves.toEqual(expect.objectContaining({ callId: expect.any(String) }));
});

test('captures the pull head SHA in the approval envelope', async () => {
  const github = require('../../../services/githubAppService');
  github.getPullRequest.mockResolvedValue({ head: { sha: 'head-sha-1' } });
  mockRoomGrant.findOne.mockResolvedValue(grant({
    tools: ['github.merge_pull_request'], writeMode: 'write',
  }));
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.merge_pull_request',
    args: { pullNumber: 42, mergeMethod: 'squash' },
  })).rejects.toMatchObject({ code: 'approval_required' });
  expect(mockProposeAction).toHaveBeenCalledWith(expect.objectContaining({
    toolCall: expect.objectContaining({
      canonicalArgs: {
        pullNumber: 42, mergeMethod: 'squash', headSha: 'head-sha-1',
        owner: 'Team-Commonly', repo: 'commonly',
      },
      // Whose credential the parked call would spend (plan §8).
      credentialOwnerId: 'owner-1',
    }),
  }));
  expect(github.getPullRequest).toHaveBeenCalledWith(expect.objectContaining({
    pullNumber: 42, installationId: 'gh-1', forceApp: true,
  }));
});

test('the envelope overwrites an agent-supplied owner and repo', async () => {
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue',
    args: { title: 'hello', owner: 'attacker', repo: 'other-repo' },
  })).rejects.toMatchObject({ code: 'approval_required' });
  const proposed = mockProposeAction.mock.calls[0][0].toolCall;
  expect(proposed.canonicalArgs).toEqual({
    title: 'hello', owner: 'Team-Commonly', repo: 'commonly',
  });
});

test('the envelope pins owner/repo and a changed connection refuses', async () => {
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue', args: { title: 'hello' },
  })).rejects.toMatchObject({ code: 'approval_required' });
  const proposed = mockProposeAction.mock.calls[0][0].toolCall;
  expect(proposed.canonicalArgs).toEqual({
    title: 'hello', owner: 'Team-Commonly', repo: 'commonly',
  });

  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected', createdBy: 'owner-1',
    createdAt: ROW_CREATED_AT,
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'another-repo' },
  });
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue',
    args: proposed.canonicalArgs, expectedArgsDigest: proposed.argsDigest, approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'repo_mismatch', statusCode: 409 });
  expect(require('../../../services/githubAppService').createIssue).not.toHaveBeenCalled();
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'repo_mismatch', approvalId: 'approval-1',
  }));
});

// The arm is inside `resolveConnection`, so the parked-write path inherits it.
// Nothing else witnesses that: a caller-side placement keeps every
// `callTool` witness green while this path loses the guard (Vera 74521).
test('the approved envelope refuses a grant that predates the re-added connection row', async () => {
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue', args: { title: 'hello' },
  })).rejects.toMatchObject({ code: 'approval_required' });
  const proposed = mockProposeAction.mock.calls[0][0].toolCall;

  // Same installationId, same owner/repo — the ONLY divergence is the row's
  // age, so nothing else in the envelope check can answer for the refusal.
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected', createdBy: 'owner-2',
    createdAt: new Date(GRANT_CREATED_AT.getTime() + 60000),
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.create_issue',
    args: proposed.canonicalArgs, expectedArgsDigest: proposed.argsDigest, approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'connection_superseded' });
  expect(require('../../../services/githubAppService').createIssue).not.toHaveBeenCalled();
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'connection_superseded', approvalId: 'approval-1',
  }));
});

test('a push after propose refuses the merge when the head SHA moved', async () => {
  const github = require('../../../services/githubAppService');
  github.getPullRequest.mockResolvedValue({ head: { sha: 'head-sha-1' } });
  mockRoomGrant.findOne.mockResolvedValue(grant({
    tools: ['github.merge_pull_request'], writeMode: 'write',
  }));
  await expect(broker.callTool({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.merge_pull_request',
    args: { pullNumber: 42 },
  })).rejects.toMatchObject({ code: 'approval_required' });
  const proposed = mockProposeAction.mock.calls[0][0].toolCall;
  github.mergePullRequest.mockRejectedValue({ response: { status: 409 } });
  await expect(broker.executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-1', tool: 'github.merge_pull_request',
    args: proposed.canonicalArgs, expectedArgsDigest: proposed.argsDigest, approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'merge_head_mismatch', statusCode: 409 });
  expect(github.mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({
    owner: 'Team-Commonly', repo: 'commonly', sha: 'head-sha-1',
  }));
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'merge_head_mismatch', approvalId: 'approval-1',
  }));
});
