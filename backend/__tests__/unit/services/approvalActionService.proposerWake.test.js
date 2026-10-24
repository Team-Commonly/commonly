/**
 * #2160 — approving a proposal tells the agent that proposed it.
 *
 * A fresh-signup run (2026-10-14): Scout proposed a seat for the user's Claude
 * Code, the user approved it, and the room went quiet. resolveApproval updated
 * the card and executed the action but told the proposer nothing, so the next
 * step never arrived. Ruled: approve wakes the proposer once with a typed
 * `approval.resolved` event (the `decision.ruled` shape); a decline wakes
 * nothing; a lost wake never fails the decision.
 */

const mockApprovalFindById = jest.fn();
const mockApprovalFindOneAndUpdate = jest.fn();
jest.mock('../../../models/ApprovalAction', () => ({
  findById: (...args) => mockApprovalFindById(...args),
  findOneAndUpdate: (...args) => mockApprovalFindOneAndUpdate(...args),
  create: jest.fn(),
}));

const mockPodCreate = jest.fn();
jest.mock('../../../models/Pod', () => ({
  create: (...args) => mockPodCreate(...args),
  findById: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({}),
}));

const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findById: (...args) => mockUserFindById(...args),
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const mockInstallFindOne = jest.fn();
const mockInstallUpsert = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => mockInstallFindOne(...args),
    findOneAndUpdate: (...args) => mockInstallUpsert(...args),
  },
  AgentRegistry: {
    getByName: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ latestVersion: '1.0.0' }),
  },
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn().mockResolvedValue(null),
  syncUserToPostgreSQL: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
// Name reservation has its own suite (agentNameReservation); these arms use free names.
jest.mock('../../../services/agentNameReservation', () => ({ reservedAgentNameRefusal: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../services/attentionItemService', () => ({
  recordActionApproval: jest.fn().mockResolvedValue(undefined),
  resolve: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../models/Message', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue({ id: 1 }) }));

const mockEnqueue = jest.fn();
jest.mock('../../../services/agentEventService', () => ({
  enqueue: (...args) => mockEnqueue(...args),
}));

const { resolveApproval } = require('../../../services/approvalActionService');

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaa1';

const row = (over = {}) => ({
  _id: 'appr-1',
  podId: 'pod-1',
  messageId: 'not-numeric-mongo-id',
  ownerUserId: OWNER,
  agentName: 'scout',
  instanceId: 'default',
  actionType: 'connect_local_agent',
  params: { name: 'growth-claude' },
  summary: 'Open a seat for your Claude Code agent',
  status: 'flagged',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

const decide = async (decision, over = {}) => {
  mockApprovalFindById.mockResolvedValue(row(over));
  const resolved = row({ ...over, status: 'resolved', decision, resolvedAt: new Date('2026-10-14T07:03:59Z') });
  mockApprovalFindOneAndUpdate.mockResolvedValue(resolved);
  const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision });
  return { res, resolved };
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PG_HOST;
  mockUserFindById.mockReturnValue({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ isBot: false, username: 'growth', displayName: 'Growth Tester' }) })),
  });
  mockEnqueue.mockResolvedValue({});
  // foreign-owner probe, then the active-install probe: a brand-new seat
  mockInstallFindOne.mockResolvedValue(null);
  mockInstallUpsert.mockResolvedValue({});
});

describe('approving a proposal wakes the agent that proposed it', () => {
  test('connect_local_agent: one approval.resolved to the proposer, naming the approver, the seat and its connect page', async () => {
    const { res } = await decide('approved');
    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [event] = mockEnqueue.mock.calls[0];
    expect(event).toEqual(expect.objectContaining({
      agentName: 'scout',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'approval.resolved',
    }));
    expect(event.payload).toEqual(expect.objectContaining({
      approvalId: 'appr-1',
      actionType: 'connect_local_agent',
      decision: 'approved',
      approvedBy: { userId: OWNER, username: 'Growth Tester' },
      resolvedAt: '2026-10-14T07:03:59.000Z',
      podId: 'pod-1',
    }));
    const cue = event.payload.content;
    expect(cue).toMatch(/^\[Your proposal was approved\]/);
    expect(cue).toContain('Growth Tester approved your proposal: Open a seat for your Claude Code agent');
    expect(cue).toContain('"growth-claude"');
    expect(cue).toContain('/v2/agents/byo?pod=pod-1&name=growth-claude');
    expect(cue).toMatch(/one next step/);
    // D1 holds through the cue: the seat's credential is a human-in-browser act.
    expect(cue).not.toMatch(/cm_agent_|token:/i);
  });

  test('create_pod: the cue names the pod that now exists', async () => {
    mockPodCreate.mockResolvedValue({ _id: 'pod-new', name: 'Design Studio' });
    await decide('approved', { actionType: 'create_pod', params: { name: 'Design Studio', type: 'chat' }, summary: 'Create a pod for design work' });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][0].payload.content).toContain('The pod "Design Studio" now exists (pod-new).');
  });

  test('create_pod: English cue gives Scout the exact one-line reply', async () => {
    mockPodCreate.mockResolvedValue({ _id: 'pod-new', name: 'Design Studio' });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ displayName: 'Scout', config: {} }) });
    mockInstallUpsert.mockResolvedValue({});
    jest.requireMock('../../../services/agentIdentityService').getOrCreateAgentUser.mockResolvedValueOnce({ _id: 'scout-bot' });
    await decide('approved', { actionType: 'create_pod', params: { name: 'Design Studio', type: 'chat' }, summary: 'Create a pod for design work' });
    expect(jest.requireMock('../../../services/agentMessageService').postMessage).toHaveBeenCalledTimes(1);
    const cue = mockEnqueue.mock.calls[0][0].payload.content;
    expect(cue).toContain('Reply with exactly this one line: Design Studio is ready. Open it and answer one question to get your first task.');
    expect(cue).not.toContain('weekly workflow');
    expect(cue).not.toContain('in a sentence or two');
  });

  test('create_pod: Chinese cue gives Scout the exact one-line reply', async () => {
    mockPodCreate.mockResolvedValue({ _id: 'pod-new', name: '设计工作室' });
    mockInstallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ displayName: 'Scout', config: {} }) });
    mockInstallUpsert.mockResolvedValue({});
    jest.requireMock('../../../services/agentIdentityService').getOrCreateAgentUser.mockResolvedValueOnce({ _id: 'scout-bot' });
    await decide('approved', { actionType: 'create_pod', params: { name: '设计工作室', type: 'chat', locale: 'zh-CN' }, summary: '创建一个设计工作室' });
    expect(jest.requireMock('../../../services/agentMessageService').postMessage).toHaveBeenCalledTimes(1);
    const cue = mockEnqueue.mock.calls[0][0].payload.content;
    expect(cue).toContain('Reply with exactly this one line: 设计工作室 已建好。打开它，回答一个问题，就能拿到第一个任务。');
    expect(cue).not.toContain('weekly workflow');
    expect(cue).not.toContain('in a sentence or two');
  });

  test('create_pod: an agent that could not join posted nothing, and the cue claims no prompt', async () => {
    mockPodCreate.mockResolvedValue({ _id: 'pod-new', name: 'Design Studio' });
    await decide('approved', { actionType: 'create_pod', params: { name: 'Design Studio', type: 'chat' }, summary: 'Create a pod for design work' });
    expect(mockEnqueue.mock.calls[0][0].payload.content).not.toContain('asked for a repo link');
  });

  test('a failed execution still wakes the proposer, with the failure to explain', async () => {
    mockPodCreate.mockRejectedValue(new Error('mongo down'));
    const { res } = await decide('approved', { actionType: 'create_pod', params: { name: 'X', type: 'chat' }, summary: 'Create a pod' });
    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][0].payload.content).toContain('But the action failed: mongo down.');
  });

  test('a decline wakes nothing', async () => {
    const { res } = await decide('declined');
    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('an already-decided approval wakes nothing (only the winning resolver reaches the wake)', async () => {
    mockApprovalFindById.mockResolvedValue(row({ status: 'resolved', decision: 'approved' }));
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a lost race wakes nothing', async () => {
    mockApprovalFindById.mockResolvedValue(row());
    mockApprovalFindOneAndUpdate.mockResolvedValue(null);
    const res = await resolveApproval({ approvalId: 'appr-1', callerUserId: OWNER, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a failed wake never fails the decision', async () => {
    mockEnqueue.mockRejectedValue(new Error('queue down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { res } = await decide('approved');
    expect(res.status).toBe(200);
    expect(res.body.approval.decision).toBe('approved');
    expect(warn).toHaveBeenCalledWith('[approval] proposer wake failed:', 'queue down');
    warn.mockRestore();
  });
});
