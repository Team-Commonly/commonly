/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const mockEmits = [];
jest.mock('../../../services/recordService', () => {
  const actual = jest.requireActual('../../../services/recordService');
  return {
    ...actual,
    emitRecord: jest.fn((ref, key, inputs) => { mockEmits.push({ ref, key, inputs }); }),
  };
});
const mockUser = { findById: jest.fn() };
jest.mock('../../../models/User', () => mockUser);
const mockRoomGrant = { findOne: jest.fn() };
jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));

const service = require('../../../services/brokerRecordService');

const POD = '6a692a1be833c668acdb84cf';
const AGENT = '6a920d43b08dee6c42a81c9e';
const OWNER = '6a47891ee025ce2e0ca1d30b';
const podGrant = { grantId: 'grant_1', target: { kind: 'pod', id: POD } };
const seatGrant = { grantId: 'grant_2', target: { kind: 'seat', id: AGENT } };
const lean = (value) => ({ select: () => ({ lean: async () => value }) });

// Resolve one emit's lines, whether given directly or built in the queue.
const linesOf = async (emit) => (typeof emit.inputs === 'function' ? emit.inputs() : emit.inputs);
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

beforeEach(() => {
  mockEmits.length = 0;
  process.env.RECORD_V1_PODS = POD;
  mockUser.findById.mockReturnValue(lean({ _id: AGENT, isBot: true, botMetadata: { ownerUserId: OWNER } }));
  mockRoomGrant.findOne.mockReturnValue(lean(podGrant));
});
afterAll(() => { delete process.env.RECORD_V1_PODS; });

const row = (over) => ({ grant: podGrant, callId: 'tool_call_1', grantId: 'grant_1', agentUserId: AGENT, tool: 'sentry.resolve_issue', ...over });

describe('recordBrokerCall', () => {
  it.each([
    ['refused', {}, ['tool.call', 'permission.requested', 'permission.decided', 'tool.update']],
    ['ok', {}, ['tool.call', 'permission.requested', 'permission.decided', 'tool.update']],
    ['failed', {}, ['tool.call', 'permission.requested', 'permission.decided', 'tool.update']],
    ['pending_approval', { approvalId: 'approval_1', credentialOwnerId: OWNER }, ['tool.call', 'permission.requested']],
  ])('%s writes its ADR-033 lines to the grant pod chain', async (outcome, over, kinds) => {
    service.recordBrokerCall(row({ outcome, ...over }));
    expect(mockEmits).toHaveLength(1);
    expect(mockEmits[0].ref).toEqual({ podId: POD });
    expect(mockEmits[0].key).toBe('tool_call/tool_call_1');
    const lines = await linesOf(mockEmits[0]);
    expect(lines.map((l) => l.kind)).toEqual(kinds);
    expect(lines[0].actor).toEqual({ type: 'agent', id: AGENT, owner: OWNER });
  });

  it('a failed agent lookup loses only the owner, never the lines', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('mongo down'); } }) });
    service.recordBrokerCall(row({ outcome: 'ok' }));
    const lines = await linesOf(mockEmits[0]);
    expect(lines.map((l) => l.kind)).toEqual(['tool.call', 'permission.requested', 'permission.decided', 'tool.update']);
    expect(lines[0].actor).toEqual({ type: 'agent', id: AGENT });
    expect(warn).toHaveBeenCalledWith('[record] agent owner lookup failed:', 'Error');
    warn.mockRestore();
  });

  it('asks a parked call of the credential owner, on its card', async () => {
    service.recordBrokerCall(row({ outcome: 'pending_approval', approvalId: 'approval_1', credentialOwnerId: OWNER }));
    const [, requested] = await linesOf(mockEmits[0]);
    expect(requested.data).toMatchObject({ askedOf: { id: OWNER, role: 'credential-owner' }, decisionCardId: 'approval_1' });
  });

  it('leaves an approved call\'s own run row to the approval resolver, so nothing doubles', () => {
    service.recordBrokerCall(row({ outcome: 'ok', approvalId: 'approval_1' }));
    service.recordBrokerCall(row({ outcome: 'failed', approvalId: 'approval_1' }));
    service.recordBrokerCall(row({ outcome: 'refused', approvalId: 'approval_1' }));
    expect(mockEmits).toHaveLength(0);
  });

  it('records nothing for a seat grant, a missing grant, or a pod the record is off for', () => {
    // The gate open everywhere: only the pod-target rule can refuse the seat grant.
    process.env.RECORD_V1_PODS = '*';
    service.recordBrokerCall(row({ outcome: 'ok', grant: seatGrant }));
    service.recordBrokerCall(row({ outcome: 'refused', grant: undefined }));
    expect(mockEmits).toHaveLength(0);
    process.env.RECORD_V1_PODS = 'another';
    service.recordBrokerCall(row({ outcome: 'ok' }));
    expect(mockEmits).toHaveLength(0);
  });
});

describe('recordApprovalOutcome', () => {
  // The decider is the one the row stored with its terminal write (TASK-512).
  const approval = (over) => ({
    _id: 'approval_1', podId: POD, agentUserId: AGENT, toolCallEnding: 'ran',
    decidedBy: OWNER, decidedByRole: 'credential-owner', ...over,
  });
  const expiredApproval = (over) => approval({ decidedBy: 'policy', decidedByRole: 'policy', toolCallEnding: 'expired', ...over });
  const parked = { grantId: 'grant_1', callId: 'tool_call_1', tool: 'sentry.resolve_issue' };

  it('approved and run: decided by the owner, then completed', async () => {
    service.recordApprovalOutcome(approval(), parked, { kind: 'approved' });
    await flush();
    const lines = await linesOf(mockEmits[0]);
    expect(mockEmits[0].key).toBe('approval/approval_1/approved');
    expect(lines.map((l) => [l.kind, l.data.approval || l.data.status])).toEqual([
      ['permission.decided', 'approved'], ['tool.update', 'completed'],
    ]);
    expect(lines[0].data).toMatchObject({ decidedBy: OWNER, decidedByRole: 'credential-owner', toolCallId: 'tool_call_1' });
  });

  it('approved but the run failed: the update says failed', async () => {
    service.recordApprovalOutcome(approval({ toolCallEnding: 'failed' }), parked, { kind: 'approved' });
    await flush();
    expect((await linesOf(mockEmits[0]))[1].data.status).toBe('failed');
  });

  it('declined, and expired, each end the call once', async () => {
    service.recordApprovalOutcome(approval(), parked, { kind: 'declined' });
    service.recordApprovalOutcome(expiredApproval(), parked, { kind: 'expired' });
    await flush();
    expect((await linesOf(mockEmits[0])).map((l) => l.data.approval || l.data.status)).toEqual(['rejected', 'failed']);
    expect((await linesOf(mockEmits[1])).map((l) => l.data.approval || l.data.status)).toEqual(['timed_out', 'failed']);
  });

  it('writes the decider the row stored, not the caller', async () => {
    const other = '6a693bfee833c668acdce5a5';
    service.recordApprovalOutcome(approval({ decidedBy: other }), parked, { kind: 'declined' });
    await flush();
    expect((await linesOf(mockEmits[0]))[0].data).toMatchObject({ decidedBy: other, decidedByRole: 'credential-owner' });
  });

  it.each([
    ['approved', { decidedBy: undefined, decidedByRole: undefined }],
    ['approved', { decidedBy: null }],
    ['declined', { decidedByRole: undefined }],
    ['approved', { decidedBy: 'policy', decidedByRole: 'policy' }],
    ['declined', { decidedBy: 'policy' }],
    ['expired', { decidedBy: OWNER, decidedByRole: 'credential-owner' }],
    ['expired', { decidedBy: OWNER, decidedByRole: 'policy' }],
    ['expired', { decidedBy: undefined, decidedByRole: undefined }],
  ])('writes no %s lines when the stored decider is %o', async (kind, over) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = kind === 'expired' ? expiredApproval : approval;
    service.recordApprovalOutcome(base(over), parked, { kind });
    await flush();
    expect(mockEmits).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[record] approval outcome skipped: the row stores no', kind, 'decider');
    warn.mockRestore();
  });

  it('records nothing when the card sits in a DM for a seat grant', async () => {
    mockRoomGrant.findOne.mockReturnValue(lean(seatGrant));
    service.recordApprovalOutcome(approval(), { ...parked, grantId: 'grant_2' }, { kind: 'declined' });
    // A pod grant whose card is somewhere else is not this pod's call either.
    mockRoomGrant.findOne.mockReturnValue(lean({ grantId: 'grant_1', target: { kind: 'pod', id: '6a692a1be833c668acdb84ce' } }));
    service.recordApprovalOutcome(approval(), parked, { kind: 'declined' });
    await flush();
    expect(mockEmits).toHaveLength(0);
  });
});

describe('grant lines', () => {
  it('a revoke with no descendants is manual; with them, cascade, ancestor first, per pod', async () => {
    const OTHER = '6a692a1be833c668acdb84ce';
    service.recordGrantsRevoked('grant_root', [{ grantId: 'grant_root', target: { kind: 'pod', id: POD } }], OWNER);
    service.recordGrantsRevoked('grant_root', [
      { grantId: 'grant_root', target: { kind: 'pod', id: POD } },
      { grantId: 'grant_child', target: { kind: 'pod', id: POD } },
      { grantId: 'grant_far', target: { kind: 'pod', id: OTHER } },
      { grantId: 'grant_seat', target: { kind: 'seat', id: AGENT } },
    ], OWNER);
    const data = await Promise.all(mockEmits.map(async (e) => [e.ref.podId, (await linesOf(e))[0].data]));
    expect(data).toEqual([
      [POD, { grantIds: ['grant_root'], reason: 'manual' }],
      [POD, { grantIds: ['grant_root', 'grant_child'], reason: 'cascade' }],
      [OTHER, { grantIds: ['grant_root', 'grant_far'], reason: 'cascade' }],
    ]);
    expect((await linesOf(mockEmits[0]))[0].actor).toEqual({ type: 'human', id: OWNER });
  });

  it('an expired grant is revoked by the server, keyed so it is written once', async () => {
    service.recordGrantExpired(podGrant);
    expect(mockEmits[0].key).toBe('grant.expired/grant_1');
    expect((await linesOf(mockEmits[0]))[0]).toMatchObject({
      actor: { type: 'system', id: 'commonly' }, data: { grantIds: ['grant_1'], reason: 'expired' },
    });
  });

  it('grant.issued only for a pod grant', () => {
    process.env.RECORD_V1_PODS = '*';
    service.recordGrantIssued({ ...seatGrant, tools: [] }, { type: 'human', id: OWNER });
    service.recordGrantIssued({ ...podGrant, tools: ['sentry.resolve_issue'] }, { type: 'human', id: OWNER });
    expect(mockEmits.map((e) => e.key)).toEqual(['grant.issued/grant_1']);
  });
});
