const mockApproval = {
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  create: jest.fn(),
};
jest.mock('../../../models/ApprovalAction', () => mockApproval);

const mockPod = { findById: jest.fn() };
jest.mock('../../../models/Pod', () => mockPod);
const mockUser = { findById: jest.fn() };
jest.mock('../../../models/User', () => mockUser);
const mockInstall = { findOne: jest.fn() };
const mockRegistry = { getByName: jest.fn(), create: jest.fn() };
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: mockInstall, AgentRegistry: mockRegistry }));

const mockToolCall = { create: jest.fn(), digestArgs: jest.fn((args) => `digest:${JSON.stringify(args || {})}`) };
jest.mock('../../../models/ToolCall', () => mockToolCall);
const mockPostMessage = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({ postMessage: (...args) => mockPostMessage(...args) }));
jest.mock('../../../services/attentionItemService', () => ({
  recordActionApproval: jest.fn().mockResolvedValue(undefined),
  resolve: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/toolBrokerService', () => ({
  executeApprovedToolCall: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../../models/Message', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));

const service = require('../../../services/approvalActionService');
const broker = require('../../../services/toolBrokerService');

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const POD = '507f1f77bcf86cd799439011';
const toolCall = {
  grantId: 'grant-1',
  callId: 'tool_call_original',
  tool: 'github.comment_on_issue',
  canonicalArgs: { issueNumber: 7, body: 'approved text' },
  argsDigest: 'digest:{"issueNumber":7,"body":"approved text"}',
};

const row = (overrides = {}) => ({
  _id: 'approval-1', podId: POD, messageId: 'mongo-message', ownerUserId: OWNER,
  agentName: 'grant-broker', agentUserId: 'agent-1', instanceId: 'default', actionType: 'tool_call', params: {},
  toolCall: { ...toolCall }, summary: 'Add a comment (approval required)', status: 'flagged',
  expiresAt: new Date(Date.now() + 60_000), save: jest.fn().mockResolvedValue(undefined), ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.findById.mockReturnValue({
    _id: OWNER,
    isBot: false,
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ isBot: false }) })),
  });
  mockPod.findById.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ createdBy: OWNER }) })) });
  mockInstall.findOne.mockResolvedValue(null);
  mockPostMessage.mockResolvedValue({ success: true, message: { _id: 'mongo-message' } });
});

test('renders canonical args to the owner and to nobody else', () => {
  const pending = row();
  expect(JSON.stringify(service.buildCardPayload(pending))).not.toContain('approved text');
  expect(service.buildOwnerCardPayload(pending, OWNER).toolCall.canonicalArgs).toEqual(toolCall.canonicalArgs);
  expect(service.buildOwnerCardPayload(pending, OTHER).toolCall).toBeUndefined();
});

test('parks a call as an ApprovalAction owned by the granter and returns pending_approval', async () => {
  const created = row();
  mockApproval.create.mockResolvedValue(created);
  const result = await service.proposeAction({
    podId: POD, agentName: 'grant-broker', instanceId: 'default', actionType: 'tool_call', params: {},
    summary: 'Add a comment (approval required)', ownerUserId: OWNER, agentUserId: 'agent-1', toolCall,
  });
  expect(result).toEqual(expect.objectContaining({ ok: true, approvalId: 'approval-1' }));
  expect(mockApproval.create).toHaveBeenCalledWith(expect.objectContaining({
    ownerUserId: OWNER, actionType: 'tool_call', params: {}, toolCall,
  }));
  expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.not.objectContaining({ toolCall: expect.anything() }),
  }));
});

test('executes on approved with the stored args and writes the second trail row', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockResolvedValue({ callId: 'tool_call_second', result: { id: 9 } });
  const result = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(result.status).toBe(200);
  expect(broker.executeApprovedToolCall).toHaveBeenCalledWith(expect.objectContaining({
    grantId: 'grant-1', tool: 'github.comment_on_issue', args: toolCall.canonicalArgs,
    expectedArgsDigest: toolCall.argsDigest, approvalId: pending._id,
  }));
  expect(resolved.executionResult).toEqual({ id: 9 });
});

test('two concurrent approvals execute the tool once', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate
    .mockResolvedValueOnce(resolved)
    .mockResolvedValueOnce(null);
  broker.executeApprovedToolCall.mockResolvedValue({ callId: 'tool_call_second', result: { id: 9 } });

  const results = await Promise.all([
    service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' }),
    service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
});

test('does not execute on declined', async () => {
  const pending = row();
  const declined = row({ status: 'resolved', decision: 'declined', toolCall: { ...toolCall, canonicalArgs: undefined } });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(declined);
  const result = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'declined' });
  expect(result.status).toBe(200);
  expect(broker.executeApprovedToolCall).not.toHaveBeenCalled();
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', reason: 'approval_declined' }));
});

test('a late decide before any sweep answers 409 and leaves no args', async () => {
  const pending = row({ expiresAt: new Date(Date.now() - 1) });
  const expired = row({ status: 'expired', toolCall: { ...toolCall, canonicalArgs: undefined } });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(expired);
  const result = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(result.status).toBe(409);
  expect(result.body.error).toBe('expired');
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', reason: 'approval_expired' }));
  expect(mockToolCall.create.mock.calls[0][0].argsDigest).toBe(toolCall.argsDigest);
});

test('the sweep expires tool_call rows past expiresAt and scrubs their args', async () => {
  const pending = row({ expiresAt: new Date(Date.now() - 1) });
  mockApproval.find.mockResolvedValue([pending]);
  mockApproval.findOneAndUpdate.mockResolvedValue(row({ status: 'expired', toolCall: { ...toolCall, canonicalArgs: undefined } }));
  await expect(service.sweepExpiredToolCallApprovals()).resolves.toBe(1);
  expect(mockApproval.findOneAndUpdate).toHaveBeenCalledWith(
    { _id: pending._id, status: 'flagged' },
    expect.objectContaining({ $unset: { 'toolCall.canonicalArgs': 1 } }),
    { new: true },
  );
});

test('every terminal state, including moot, scrubs canonicalArgs and keeps argsDigest', async () => {
  const pending = row();
  mockApproval.create.mockResolvedValue(pending);
  mockPostMessage.mockResolvedValue({ success: false });
  const result = await service.proposeAction({
    podId: POD, agentName: 'grant-broker', instanceId: 'default', actionType: 'tool_call', params: {},
    summary: 'Add a comment (approval required)', ownerUserId: OWNER, agentUserId: 'agent-1', toolCall,
  });
  expect(result.ok).toBe(false);
  expect(mockApproval.updateOne).toHaveBeenCalledWith(
    { _id: pending._id, status: 'flagged' },
    expect.objectContaining({
      $set: { status: 'moot' },
      $unset: { 'toolCall.canonicalArgs': 1 },
    }),
  );
  expect(pending.toolCall.argsDigest).toBe(toolCall.argsDigest);
  expect(pending.toolCall.canonicalArgs).toBeUndefined();
});
