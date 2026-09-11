const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockToolCall = { create: jest.fn(), digestArgs: (args) => `digest:${JSON.stringify(args || {})}` };
const mockReserveBudgetLineage = jest.fn().mockResolvedValue(true);
jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
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

const grant = (overrides = {}) => ({
  grantId: 'grant-1', connectionId: 'connection-1', installationId: 'install-1',
  target: { kind: 'seat', id: 'agent-1' }, tools: ['github.create_issue'], writeMode: 'write',
  audience: ['agent-1'], expiresAt: new Date(Date.now() + 60_000), ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockRoomGrant.findOne.mockResolvedValue(grant());
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected', createdBy: 'owner-1',
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockProposeAction.mockResolvedValue({ ok: true, approvalId: 'approval-1' });
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
    outcome: 'pending_approval', approvalId: 'approval-1',
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
    args: { title: 'hello' }, expectedArgsDigest: 'digest:{"title":"hello"}', approvalId: 'approval-1',
  })).rejects.toMatchObject({ code: 'budget_exhausted' });
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'budget_exhausted', approvalId: 'approval-1',
  }));
  expect(mockReserveBudgetLineage).toHaveBeenCalled();
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
      canonicalArgs: { pullNumber: 42, mergeMethod: 'squash', headSha: 'head-sha-1' },
    }),
  }));
  expect(github.getPullRequest).toHaveBeenCalledWith(expect.objectContaining({
    pullNumber: 42, installationId: 'gh-1', forceApp: true,
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
  expect(github.mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ sha: 'head-sha-1' }));
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'merge_head_mismatch', approvalId: 'approval-1',
  }));
});
