/**
 * W1 commit 0 — the decider derivation (ADR-020 D2/D3, plan
 * docs/plans/2026-08-13-agent-platform-consolidation.md).
 *
 * `ownerUserId = pod.createdBy` made cards undecidable by construction in
 * bot-created pods — 63 of 261 production pods, measured. The owner-only
 * resolve gate then refused a decider who could never exist and the card sat
 * on the WAITING face forever.
 *
 * These pin the derivation itself:
 *  - the accountable human is the INSTALLER first, pod creator as fallback
 *  - a candidate must RESOLVE to a non-bot User, not merely be present —
 *    agentsRuntime's auto-install writes a bot _id, and the seeder writes a
 *    hardcoded admin id that is a dangling ref on a self-hosted instance
 *  - when no human resolves we REFUSE to mint; no row, no card message
 *
 * Sibling of approvalActionService.test.js, which covers resolve/execute.
 */

const mockApprovalCreate = jest.fn();
jest.mock('../../../models/ApprovalAction', () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  create: (...args) => mockApprovalCreate(...args),
}));

const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockPodFindById(...args),
  create: jest.fn(),
  updateOne: jest.fn(),
}));

const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findById: (...args) => mockUserFindById(...args),
}));

const mockInstallFindOne = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => mockInstallFindOne(...args),
    findOneAndUpdate: jest.fn(),
  },
  AgentRegistry: { getByName: jest.fn(), create: jest.fn() },
}));

const mockPostMessage = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: (...args) => mockPostMessage(...args),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  syncUserToPostgreSQL: jest.fn(),
}));

jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));

const { proposeAction } = require('../../../services/approvalActionService');

const HUMAN_INSTALLER = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const HUMAN_POD_CREATOR = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const BOT_USER = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const DANGLING = 'cccccccccccccccccccccccc';

// Pod.findById(...).select(...).lean()
const podLookup = (createdBy) => {
  mockPodFindById.mockReturnValue({
    select: () => ({ lean: async () => (createdBy === null ? null : { createdBy }) }),
  });
};

// AgentInstallation.findOne serves two callers: the decider lookup (keyed on
// podId) and findForeignLocalAgentOwner (keyed on installedBy $ne). Route by
// query shape so a test can drive them independently.
const installLookup = ({ installedBy, foreignOwner = null }) => {
  mockInstallFindOne.mockImplementation((query) => {
    if (query && query.installedBy) return Promise.resolve(foreignOwner);
    return Promise.resolve(installedBy === null ? null : { installedBy });
  });
};

const userLookup = (byId) => {
  mockUserFindById.mockImplementation(async (id) => byId[String(id)] || null);
};

const HUMANS = {
  [HUMAN_INSTALLER]: { _id: HUMAN_INSTALLER, isBot: false },
  [HUMAN_POD_CREATOR]: { _id: HUMAN_POD_CREATOR, isBot: false },
  [BOT_USER]: { _id: BOT_USER, isBot: true },
};

const propose = (over = {}) => proposeAction({
  podId: 'pod-1',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  actionType: 'create_pod',
  params: { name: 'Design Studio', type: 'chat' },
  summary: 'Create a pod for design work',
  ...over,
});

describe('proposeAction — decider derivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApprovalCreate.mockImplementation(async (doc) => ({
      ...doc,
      _id: 'appr-1',
      // The schema defaults this; buildCardPayload calls toISOString on it.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      save: jest.fn().mockResolvedValue(undefined),
    }));
    mockPostMessage.mockResolvedValue({ success: true, message: { _id: 'msg-1' } });
    userLookup(HUMANS);
  });

  test('human-created pod with no installation — creator is the decider (baseline)', async () => {
    podLookup(HUMAN_POD_CREATOR);
    installLookup({ installedBy: null });

    const result = await propose();

    expect(result.ok).toBe(true);
    expect(mockApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: HUMAN_POD_CREATOR }),
    );
  });

  test('bot-created pod with a human installer — the installer decides (the 63/261 fix)', async () => {
    podLookup(BOT_USER);
    installLookup({ installedBy: HUMAN_INSTALLER });

    const result = await propose();

    expect(result.ok).toBe(true);
    expect(mockApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: HUMAN_INSTALLER }),
    );
  });

  test('installer outranks pod creator when both are human (accountability order)', async () => {
    podLookup(HUMAN_POD_CREATOR);
    installLookup({ installedBy: HUMAN_INSTALLER });

    await propose();

    expect(mockApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: HUMAN_INSTALLER }),
    );
  });

  test('bot installer AND bot pod creator — refuses to mint, no row and no card', async () => {
    podLookup(BOT_USER);
    installLookup({ installedBy: BOT_USER });

    const result = await propose();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/undecidable/);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test('installedBy present but unresolvable — refuses (the self-hosted seeder hole)', async () => {
    // seed-native-agents writes a hardcoded admin ObjectId. On any other
    // instance that user does not exist, so the field is a dangling ref
    // rather than a bot — a presence check would have passed it through.
    podLookup(BOT_USER);
    installLookup({ installedBy: DANGLING });

    const result = await propose();

    expect(result.ok).toBe(false);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  test('unresolvable installer falls back to a human pod creator', async () => {
    podLookup(HUMAN_POD_CREATOR);
    installLookup({ installedBy: DANGLING });

    const result = await propose();

    expect(result.ok).toBe(true);
    expect(mockApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: HUMAN_POD_CREATOR }),
    );
  });

  test('missing pod is refused before any derivation work', async () => {
    podLookup(null);
    installLookup({ installedBy: HUMAN_INSTALLER });

    const result = await propose();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('pod not found');
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  test('connect_local_agent name guard checks the derived decider, not the pod creator', async () => {
    // Bot-created pod: pre-fix this guard compared against a bot id, so a name
    // the deciding human already owned looked foreign and got refused.
    podLookup(BOT_USER);
    installLookup({ installedBy: HUMAN_INSTALLER, foreignOwner: null });

    const result = await propose({
      actionType: 'connect_local_agent',
      params: { name: 'my-laptop' },
      summary: 'Connect your laptop agent',
    });

    expect(result.ok).toBe(true);
    const foreignCheck = mockInstallFindOne.mock.calls
      .map(([query]) => query)
      .find((query) => query && query.installedBy);
    expect(foreignCheck.installedBy).toEqual({ $ne: HUMAN_INSTALLER });
  });
});
