/**
 * W1 step 1 — the CAP producer surface for approval cards.
 *
 * Consumers were already universal (any human decides via /api/approvals);
 * producers were native-only. `POST /pods/:podId/propose-action` closes that
 * gap, and its novel rules live in `proposeActionForRuntime` so this test
 * exercises the SAME function the route calls.
 *
 * That placement is the point. The first draft of this file re-declared the
 * handler inside the test — it passed while proving nothing about the route,
 * which is the copy-drifts-from-its-source failure this repo has already paid
 * for more than once. Importing the real export is the fix.
 *
 * Validation is deliberately NOT re-tested here: it belongs to `proposeAction`
 * and is covered by approvalActionService.decider.test.js. Two validators on a
 * consent surface is how the HTTP and in-process producers drift apart.
 */

const mockInstallFindOne = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: (...args) => mockInstallFindOne(...args) },
  AgentRegistry: { getByName: jest.fn(), create: jest.fn() },
}));

const mockApprovalCreate = jest.fn();
jest.mock('../../../models/ApprovalAction', () => ({
  create: (...args) => mockApprovalCreate(...args),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockPodFindById(...args),
  create: jest.fn(),
  updateOne: jest.fn(),
}));

const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({ findById: (...args) => mockUserFindById(...args) }));

const mockPostMessage = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: (...args) => mockPostMessage(...args),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  syncUserToPostgreSQL: jest.fn(),
}));

jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));

const { proposeActionForRuntime } = require('../../../services/approvalActionService');

const POD = '6a692a1be833c668acdb84cf';
const HUMAN = 'aaaaaaaaaaaaaaaaaaaaaaa1';

const installation = (over = {}) => ({
  agentName: 'scout', instanceId: 'default', displayName: 'Scout', config: null, ...over,
});

const call = (over = {}) => proposeActionForRuntime({
  podId: POD,
  installation: installation(),
  podAuthorized: true,
  body: { actionType: 'create_pod', params: { name: 'Design Studio', type: 'chat' }, summary: 'For design work' },
  ...over,
});

describe('propose-action — the runtime producer surface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallFindOne.mockResolvedValue({ _id: 'inst-1', status: 'active', installedBy: HUMAN });
    mockPodFindById.mockReturnValue({ select: () => ({ lean: async () => ({ createdBy: HUMAN }) }) });
    mockUserFindById.mockResolvedValue({ _id: HUMAN, isBot: false });
    mockApprovalCreate.mockImplementation(async (doc) => ({
      ...doc,
      _id: 'appr-1',
      expiresAt: new Date(Date.now() + 3600_000),
      save: jest.fn().mockResolvedValue(undefined),
    }));
    mockPostMessage.mockResolvedValue({ success: true, message: { _id: 'msg-1' } });
  });

  test('an authorized agent with an active install proposes', async () => {
    const verdict = await call();

    expect(verdict.status).toBe(200);
    expect(verdict.body).toEqual(expect.objectContaining({ ok: true, approvalId: 'appr-1' }));
  });

  test('the principal comes from the TOKEN, never from the body', async () => {
    // An agent must not propose as someone else by naming them in the body.
    await call({
      body: {
        actionType: 'create_pod',
        params: { name: 'X', type: 'chat' },
        summary: 's',
        agentName: 'someone-else',
        instanceId: 'spoofed',
      },
    });

    expect(mockApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'scout', instanceId: 'default' }),
    );
  });

  test('a token not scoped to this pod is refused before any DB work', async () => {
    const verdict = await call({ podAuthorized: false });

    expect(verdict.status).toBe(403);
    expect(mockInstallFindOne).not.toHaveBeenCalled();
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  test('an inactive installation is refused even with a pod-scoped token', async () => {
    // Token scope alone is not permission to act — same gate as the claim
    // route. An uninstalled agent must not keep proposing.
    mockInstallFindOne.mockResolvedValue(null);
    const verdict = await call();

    expect(verdict.status).toBe(403);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  test('the decider refusal reaches the caller as a 400 it can act on', async () => {
    // Bot-created pod, bot installer: no accountable human resolves, so the
    // service refuses to mint. The agent needs the sentence, not a bare 400.
    mockUserFindById.mockResolvedValue({ _id: HUMAN, isBot: true });
    const verdict = await call();

    expect(verdict.status).toBe(400);
    expect(String(verdict.body.message)).toMatch(/undecidable/);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  test('validation is not duplicated in the runtime path — the service decides', async () => {
    const verdict = await call({ body: { actionType: 'nope', summary: 's' } });

    expect(verdict.status).toBe(400);
    expect(String(verdict.body.message)).toMatch(/unknown actionType/);
  });
});
