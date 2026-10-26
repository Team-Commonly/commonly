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
const mockEnqueue = jest.fn().mockResolvedValue({});
jest.mock('../../../services/agentEventService', () => ({ enqueue: (...args) => mockEnqueue(...args) }));
jest.mock('../../../models/Message', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
const mockRecordApprovalOutcome = jest.fn();
jest.mock('../../../services/brokerRecordService', () => ({
  recordApprovalOutcome: (...args) => mockRecordApprovalOutcome(...args),
}));

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
  // Whose credential the parked call would spend (plan §8), copied from the
  // Connection when the call was parked.
  credentialOwnerId: 'owner-1',
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
  expect(service.buildCardPayload(pending).toolCall).toEqual({ tool: toolCall.tool });
  expect(service.buildCardPayload(pending).toolCall.canonicalArgs).toBeUndefined();
  expect(service.buildOwnerCardPayload(pending, OWNER).toolCall.canonicalArgs).toEqual(toolCall.canonicalArgs);
  expect(service.buildOwnerCardPayload(pending, OTHER).toolCall).toEqual({ tool: toolCall.tool });
});

test('a legacy tool-call row never exposes stored vendor result or error on its card', () => {
  const completed = row({
    status: 'resolved', toolCallEnding: 'failed', toolCallCode: 'upstream_tool_error',
    toolCallTrailId: 'trail-1', executionResult: { content: 'private vendor text' },
    executionError: 'private vendor error',
  });
  const card = service.buildCardPayload(completed);
  expect(card).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'upstream_tool_error', toolCallTrailId: 'trail-1' });
  expect(JSON.stringify(card)).not.toContain('private vendor');
});

test('a pre-ending tool-call row projects its stored success or failure without vendor content', () => {
  const succeeded = service.buildCardPayload(row({
    status: 'resolved', decision: 'approved', executionResult: { id: 9, content: 'private vendor text' },
  }));
  expect(succeeded.toolCallEnding).toBe('ran');
  expect(JSON.stringify(succeeded)).not.toContain('private vendor');

  const failed = service.buildCardPayload(row({
    status: 'resolved', decision: 'approved', executionError: 'private vendor error',
  }));
  expect(failed).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'legacy_execution_failed' });
  expect(JSON.stringify(failed)).not.toContain('private vendor');

  const providerFailed = service.buildCardPayload(row({
    status: 'resolved', decision: 'approved', executionResult: { isError: true, content: 'private vendor text' },
  }));
  expect(providerFailed).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'legacy_execution_failed' });
  expect(JSON.stringify(providerFailed)).not.toContain('private vendor');
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
    payload: expect.objectContaining({ toolCall: { tool: toolCall.tool } }),
  }));
  expect(mockPostMessage.mock.calls[0][0].payload.toolCall.canonicalArgs).toBeUndefined();
});

test('a parked card deadline is capped at its grant expiry', async () => {
  mockApproval.create.mockResolvedValue(row());
  const grantExpiry = new Date(Date.now() + 5000);
  await service.proposeAction({
    podId: POD, agentName: 'grant-broker', instanceId: 'default', actionType: 'tool_call', params: {},
    summary: 'Add a comment (approval required)', ownerUserId: OWNER, agentUserId: 'agent-1', toolCall,
    approvalExpiresAt: grantExpiry,
  });
  expect(mockApproval.create).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: grantExpiry }));
});

test('executes on approved with the stored args and writes the second trail row', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockResolvedValue({ callId: 'tool_call_second', outcome: 'ok', result: { id: 9 } });
  const result = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(result.status).toBe(200);
  expect(broker.executeApprovedToolCall).toHaveBeenCalledWith(expect.objectContaining({
    grantId: 'grant-1', tool: 'github.comment_on_issue', args: toolCall.canonicalArgs,
    expectedArgsDigest: toolCall.argsDigest, approvalId: pending._id,
  }));
  expect(resolved.toolCallEnding).toBe('ran');
  expect(resolved.toolCallTrailId).toBe('tool_call_second');
  expect(resolved.executionResult).toBeUndefined();
  expect(mockEnqueue).toHaveBeenCalledTimes(1);
  expect(mockEnqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
    type: 'approval.resolved', payload: expect.objectContaining({
      approvalId: 'approval-1', actionType: 'tool_call', ending: 'ran', callId: 'tool_call_second',
    }),
  }));
  expect(JSON.stringify(mockEnqueue.mock.calls[0][0])).not.toContain('approved text');
});

test('passes a parked hosted definition digest to the broker without exposing it on the card', async () => {
  const pending = row({ toolCall: { ...toolCall, tool: 'linear.create_issue', definitionDigest: 'pinned-definition' } });
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockResolvedValue({ result: { id: 9 } });

  expect(service.buildCardPayload(pending).toolCall).toEqual({ tool: 'linear.create_issue' });
  await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(broker.executeApprovedToolCall).toHaveBeenCalledWith(expect.objectContaining({
    expectedDefinitionDigest: 'pinned-definition',
  }));
});

test('uses the approver display name in the execution receipt', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  mockUser.findById.mockReturnValue({
    select: jest.fn(() => ({
      lean: jest.fn().mockResolvedValue({ isBot: false, username: 'samxu01', displayName: 'Sam Xu' }),
    })),
  });
  broker.executeApprovedToolCall.mockResolvedValue({ callId: 'tool_call_second', outcome: 'ok', result: { id: 9 } });

  await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });

  expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: "Sam Xu approved grant-broker's github.comment_on_issue · ran",
  }));
});

test('an isError result keeps its failed ending and hides vendor content from card and event', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockResolvedValue({
    callId: 'trail-failed', outcome: 'failed', result: { isError: true, content: [{ text: 'private vendor text' }] },
  });
  await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(resolved).toMatchObject({
    toolCallEnding: 'failed', toolCallCode: 'upstream_tool_error', toolCallTrailId: 'trail-failed',
  });
  expect(JSON.stringify(service.buildCardPayload(resolved))).not.toContain('private vendor text');
  expect(JSON.stringify(mockEnqueue.mock.calls[0][0])).not.toContain('private vendor text');
  expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining(' · failed (upstream_tool_error)'),
  }));
});

test.each(['grant_expired', 'budget_exhausted', 'merge_head_mismatch', 'definition_digest_mismatch'])(
  'an approved broker refusal %s delivers its code and trail id without vendor prose', async (code) => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('private vendor text'), {
    code, details: { callId: 'trail-refused', outcome: 'refused', recorded: true },
  }));
  await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(resolved).toMatchObject({
    toolCallEnding: 'refused', toolCallCode: code, toolCallTrailId: 'trail-refused',
  });
  expect(JSON.stringify(service.buildCardPayload(resolved))).not.toContain('private vendor text');
  expect(mockEnqueue.mock.calls[0][0].payload.content).toContain(code);
  expect(JSON.stringify(mockEnqueue.mock.calls[0][0])).not.toContain('private vendor text');
  expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining(` · refused (${code})`),
  }));
  },
);

test('a definition change refusal reaches the card with its code and no vendor error text', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('private vendor text'), {
    code: 'definition_digest_mismatch',
    details: { callId: 'trail-changed', outcome: 'refused', recorded: true },
  }));
  const response = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(response.body.approval).toMatchObject({
    toolCallEnding: 'refused', toolCallCode: 'definition_digest_mismatch', toolCallTrailId: 'trail-changed',
  });
  expect(JSON.stringify(response.body.approval)).not.toContain('private vendor text');
  expect(mockEnqueue.mock.calls[0][0].payload.code).toBe('definition_digest_mismatch');
  expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining(' · refused (definition_digest_mismatch)'),
  }));
});

test('two concurrent approvals execute the tool once', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate
    .mockResolvedValueOnce(resolved)
    .mockResolvedValueOnce(null);
  broker.executeApprovedToolCall.mockResolvedValue({ callId: 'tool_call_second', outcome: 'ok', result: { id: 9 } });

  const results = await Promise.all([
    service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' }),
    service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  expect(mockEnqueue).toHaveBeenCalledTimes(1);
});

test('a failed tool-call event enqueue never reverses the decision', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  mockEnqueue.mockRejectedValueOnce(new Error('queue unavailable'));
  broker.executeApprovedToolCall.mockResolvedValue({ callId: 'trail-ok', outcome: 'ok', result: { body: 'private vendor text' } });
  await expect(service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' }))
    .resolves.toMatchObject({ status: 200 });
  expect(resolved.toolCallEnding).toBe('ran');
  expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
});

test('a declared receipt is delivered without the provider result', async () => {
  const pending = row();
  const resolved = row({ status: 'resolved', decision: 'approved' });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
  broker.executeApprovedToolCall.mockResolvedValue({
    callId: 'trail-ok', outcome: 'ok', receipt: { number: 17 }, result: { body: 'private vendor text' },
  });
  await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(mockEnqueue.mock.calls[0][0].payload).toMatchObject({ receipt: { number: 17 }, ending: 'ran' });
  expect(JSON.stringify(mockEnqueue.mock.calls[0][0])).not.toContain('private vendor text');
});

test('does not execute on declined', async () => {
  const pending = row();
  const declined = row({ status: 'resolved', decision: 'declined', toolCall: { ...toolCall, canonicalArgs: undefined } });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(declined);
  const result = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'declined' });
  expect(result.status).toBe(200);
  expect(broker.executeApprovedToolCall).not.toHaveBeenCalled();
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused',
    reason: 'approval_declined',
    // The decision's record keeps naming the owner: the Connection row may be
    // gone by the time a person rules (plan §8).
    credentialOwnerId: 'owner-1',
  }));
  expect(declined).toMatchObject({ toolCallEnding: 'declined', toolCallCode: 'approval_declined' });
  expect(mockEnqueue).toHaveBeenCalledTimes(1);
  expect(mockEnqueue.mock.calls[0][0].payload).toMatchObject({
    actionType: 'tool_call', ending: 'declined', code: 'approval_declined',
  });
});

test('a late decide before any sweep answers 409 and leaves no args', async () => {
  const pending = row({ expiresAt: new Date(Date.now() - 1) });
  const expired = row({ status: 'expired', toolCall: { ...toolCall, canonicalArgs: undefined } });
  mockApproval.findById.mockResolvedValue(pending);
  mockApproval.findOneAndUpdate.mockResolvedValue(expired);
  const result = await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
  expect(result.status).toBe(409);
  expect(result.body.error).toBe('expired');
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused',
    reason: 'approval_expired',
    credentialOwnerId: 'owner-1',
  }));
  expect(mockToolCall.create.mock.calls[0][0].argsDigest).toBe(toolCall.argsDigest);
  expect(expired).toMatchObject({ toolCallEnding: 'expired', toolCallCode: 'approval_expired' });
  expect(mockEnqueue.mock.calls[0][0].payload.ending).toBe('expired');
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
  expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'refused', reason: 'approval_expired', approvalId: pending._id,
  }));
  expect(mockEnqueue.mock.calls[0][0].payload.ending).toBe('expired');
});

test('a sweep losing the decision race emits no second event or trail', async () => {
  mockApproval.find.mockResolvedValue([row({ expiresAt: new Date(Date.now() - 1) })]);
  mockApproval.findOneAndUpdate.mockResolvedValue(null);
  await expect(service.sweepExpiredToolCallApprovals()).resolves.toBe(0);
  expect(mockEnqueue).not.toHaveBeenCalled();
  expect(mockToolCall.create).not.toHaveBeenCalled();
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

// TASK-560: one terminal record per parked call, after its ending is saved.
describe('record wiring', () => {
  const outcomeCall = () => {
    expect(mockRecordApprovalOutcome).toHaveBeenCalledTimes(1);
    return mockRecordApprovalOutcome.mock.calls[0];
  };

  test('approved: after the run, with the approver, and the saved ending', async () => {
    const pending = row();
    const resolved = row({ status: 'resolved', decision: 'approved' });
    mockApproval.findById.mockResolvedValue(pending);
    mockApproval.findOneAndUpdate.mockResolvedValue(resolved);
    broker.executeApprovedToolCall.mockResolvedValue({ callId: 'tool_call_second', outcome: 'ok', result: {} });
    await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'approved' });
    const [approval, parked, outcome] = outcomeCall();
    expect(approval).toBe(resolved);
    expect(approval.toolCallEnding).toBe('ran');
    expect(parked).toMatchObject({ grantId: 'grant-1', callId: 'tool_call_original', tool: toolCall.tool });
    expect(outcome).toEqual({ kind: 'approved', resolvedBy: OWNER });
  });

  test('declined', async () => {
    const pending = row();
    mockApproval.findById.mockResolvedValue(pending);
    mockApproval.findOneAndUpdate.mockResolvedValue(row({ status: 'resolved', decision: 'declined' }));
    await service.resolveApproval({ approvalId: pending._id, callerUserId: OWNER, decision: 'declined' });
    expect(outcomeCall()[2]).toEqual({ kind: 'declined', resolvedBy: OWNER });
  });

  test('expired at decide time, and in the sweep', async () => {
    mockApproval.findById.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }));
    mockApproval.findOneAndUpdate.mockResolvedValue(row({ status: 'expired' }));
    await service.resolveApproval({ approvalId: 'approval-1', callerUserId: OWNER, decision: 'approved' });
    expect(outcomeCall()[2]).toEqual({ kind: 'expired' });
    mockRecordApprovalOutcome.mockClear();
    mockApproval.find.mockResolvedValue([row({ expiresAt: new Date(Date.now() - 1) })]);
    await service.sweepExpiredToolCallApprovals();
    expect(outcomeCall()[2]).toEqual({ kind: 'expired' });
  });

  test('a lost race and a refused decider write nothing', async () => {
    mockApproval.find.mockResolvedValue([row({ expiresAt: new Date(Date.now() - 1) })]);
    mockApproval.findOneAndUpdate.mockResolvedValue(null);
    await service.sweepExpiredToolCallApprovals();
    mockApproval.findById.mockResolvedValue(row());
    await service.resolveApproval({ approvalId: 'approval-1', callerUserId: OTHER, decision: 'approved' });
    expect(mockRecordApprovalOutcome).not.toHaveBeenCalled();
  });
});
