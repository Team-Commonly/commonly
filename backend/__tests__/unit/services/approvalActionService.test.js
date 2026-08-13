/**
 * ADR-020 D2/D3 — the approval lifecycle's load-bearing invariants:
 *  - only the owner decides; agents (isBot) never decide even as owner
 *  - one-way transitions: resolve at most once, execute at most once
 *  - expiry fails closed ("retiring an escalation is never an approval")
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
}));

const mockInstallFindOne = jest.fn();
const mockInstallUpsert = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => mockInstallFindOne(...args),
    findOneAndUpdate: (...args) => mockInstallUpsert(...args),
  },
}));

const mockGetOrCreateAgentUser = jest.fn();
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: (...args) => mockGetOrCreateAgentUser(...args),
  syncUserToPostgreSQL: jest.fn(),
}));

jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));

const { resolveApproval } = require('../../../services/approvalActionService');

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

  test('expiry fails closed: 410, row marked expired, nothing executes', async () => {
    const row = flaggedRow({ expiresAt: new Date(Date.now() - 1000) });
    mockApprovalFindById.mockResolvedValue(row);
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(410);
    expect(row.status).toBe('expired');
    expect(row.save).toHaveBeenCalled();
    expect(mockPodCreate).not.toHaveBeenCalled();
  });

  test('losing the atomic transition race returns 409 without executing', async () => {
    mockApprovalFindById.mockResolvedValue(flaggedRow());
    mockApprovalFindOneAndUpdate.mockResolvedValue(null);
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(mockPodCreate).not.toHaveBeenCalled();
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
    mockPodCreate.mockResolvedValue({ _id: 'newpod-1', name: 'Design Studio' });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ displayName: 'Guide', scopes: ['context:read'], config: {}, version: '1.0.0' }) });
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
    expect(mockPodUpdateOne).toHaveBeenCalledWith(
      { _id: 'newpod-1', members: { $ne: 'guide-bot-1' } },
      { $push: { members: 'guide-bot-1' } },
    );
    expect(resolved.executedAt).toBeInstanceOf(Date);
    expect(resolved.executionResult).toEqual(expect.objectContaining({ podId: 'newpod-1' }));
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
