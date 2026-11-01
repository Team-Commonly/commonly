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
  // The BYO name allocator lists the caller's pods; none here, so names stay free.
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  create: jest.fn(),
  updateOne: jest.fn(),
}));

const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findById: (...args) => mockUserFindById(...args),
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
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
// Name reservation has its own suite (agentNameReservation); these arms use free names.
jest.mock('../../../services/agentNameReservation', () => ({ reservedAgentNameRefusal: jest.fn().mockResolvedValue(null) }));
const mockRecordActionApproval = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/attentionItemService', () => ({
  recordActionApproval: (...args) => mockRecordActionApproval(...args),
  resolve: jest.fn().mockResolvedValue(undefined),
}));

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

  test('a posted proposal is projected into the inbox as an approval ask (#1650)', async () => {
    podLookup(HUMAN_POD_CREATOR);
    installLookup({ installedBy: null });

    const result = await propose();

    expect(result.ok).toBe(true);
    expect(mockRecordActionApproval).toHaveBeenCalledTimes(1);
    expect(mockRecordActionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'appr-1', podId: 'pod-1', agentName: 'scout', summary: 'Create a pod for design work', messageId: 'msg-1' }),
      'Scout',
    );
  });

  test('a native broker-marked proposal suppresses outbound relay on its card', async () => {
    podLookup(HUMAN_POD_CREATOR);
    installLookup({ installedBy: HUMAN_INSTALLER });

    const result = await propose({ noOutboundRelay: true });

    expect(result.ok).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'card', noOutboundRelay: true,
    }));
  });

  test('a proposal whose card never posted is moot and is NOT projected — no phantom ask', async () => {
    podLookup(HUMAN_POD_CREATOR);
    installLookup({ installedBy: null });
    mockPostMessage.mockResolvedValueOnce({ success: false });

    const result = await propose();

    expect(result.ok).toBe(false);
    expect(mockRecordActionApproval).not.toHaveBeenCalled();
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

  describe('a refused name comes back with a free one built from the owner (2026-10-14)', () => {
    // Seat names are instance-wide and stay held after uninstall, so a generic
    // proposal such as "my-claude" works once per instance. The refusal hands
    // the proposing agent a concrete name that will work.
    // Three AgentInstallation.findOne callers, routed by query shape: the
    // decider lookup (podId), the foreign-owner check (installedBy $ne) and the
    // suggestion's "does anyone hold this name" check (agentName only).
    const held = (names, { ownerHolds = [] } = {}) => {
      mockInstallFindOne.mockImplementation((query) => {
        if (query && query.podId) return Promise.resolve({ installedBy: HUMAN_INSTALLER });
        if (query && query.installedBy) {
          return Promise.resolve(names.includes(query.agentName) ? { installedBy: 'someone-else' } : null);
        }
        return Promise.resolve([...names, ...ownerHolds].includes(query.agentName) ? { installedBy: 'any' } : null);
      });
    };

    beforeEach(() => {
      podLookup(HUMAN_POD_CREATOR);
      userLookup({ ...HUMANS, [HUMAN_INSTALLER]: { _id: HUMAN_INSTALLER, isBot: false, username: 'Sam Lee' } });
    });

    test('an adapter other than claude or codex is refused at proposal', async () => {
      held([]);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'sams-cursor', adapter: 'cursor' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('params.adapter must be one of: claude, codex');
      expect(mockApprovalCreate).not.toHaveBeenCalled();
    });

    test('a name another user holds is refused with a free, username-based suggestion', async () => {
      held(['my-claude']);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('"my-claude" is already in use by another user');
      expect(result.error).toContain('such as "sam-lee-claude", which is free');
      expect(mockApprovalCreate).not.toHaveBeenCalled();
    });

    test('a name still bound to a foreign publisher is refused after its installs disappear', async () => {
      held([]);
      const { AgentRegistry } = require('../../../models/AgentRegistry');
      AgentRegistry.getByName.mockResolvedValueOnce({ ephemeral: true, publisher: { userId: HUMAN_POD_CREATOR } });
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('already in use by another user');
      expect(mockApprovalCreate).not.toHaveBeenCalled();
    });

    test('a durable principal owner refuses adoption even without installs or registry row', async () => {
      held([]);
      const User = require('../../../models/User');
      User.findOne.mockReturnValueOnce({
        select: () => ({ lean: async () => ({ botMetadata: { ownerUserId: HUMAN_POD_CREATOR } }) }),
      });
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('already in use by another user');
      expect(mockApprovalCreate).not.toHaveBeenCalled();
    });

    test('the suggestion skips a candidate someone else already holds', async () => {
      held(['my-claude', 'sam-lee-claude']);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.error).toContain('"sam-lee-claude-2"');
    });

    test('a built-in name is refused with the same kind of suggestion', async () => {
      held([]);
      const { reservedAgentNameRefusal } = require('../../../services/agentNameReservation');
      reservedAgentNameRefusal.mockResolvedValueOnce({ code: 'agent_name_reserved', error: 'reserved' });
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'claude-code' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('"claude-code" belongs to a built-in agent');
      expect(result.error).toContain('such as "sam-lee-claude", which is free');
    });

    test('a username with no ASCII letters falls back to an id-based name, so a suggestion is always given', async () => {
      held(['my-claude']);
      userLookup({ ...HUMANS, [HUMAN_INSTALLER]: { _id: HUMAN_INSTALLER, isBot: false, username: '中文' } });
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('such as "user-aaaaa1-claude", which is free');
    });

    test('a name the owner already holds is not offered as free', async () => {
      held(['my-claude'], { ownerHolds: ['sam-lee-claude'] });
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.error).toContain('"sam-lee-claude-2"');
    });

    test('a candidate that is itself a built-in name is skipped', async () => {
      held(['bot']);
      userLookup({ ...HUMANS, [HUMAN_INSTALLER]: { _id: HUMAN_INSTALLER, isBot: false, username: 'commonly' } });
      const { reservedAgentNameRefusal } = require('../../../services/agentNameReservation');
      reservedAgentNameRefusal.mockImplementation(async (name) => (name === 'commonly-bot' ? { code: 'agent_name_reserved', error: 'reserved' } : null));
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'bot' }, summary: 'Connect' });
      expect(result.error).toContain('"commonly-bot-2"');
      reservedAgentNameRefusal.mockReset();
      reservedAgentNameRefusal.mockResolvedValue(null);
    });

    // QA BYO walk 2 (2026-10-16): the username "eng-smoke-byo2-470105" was cut
    // to "...-47010" and joined to the whole proposed name: 37 characters,
    // the last word of the command people paste, wrapping it at 1440.
    test('a long username keeps its leading whole words, and the name says the tool', async () => {
      userLookup({ ...HUMANS, [HUMAN_INSTALLER]: { _id: HUMAN_INSTALLER, isBot: false, username: 'eng-smoke-byo2-470105' } });
      held(['eng-smoke-claude']);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'eng-smoke-claude' }, summary: 'Connect' });
      const suggested = result.error.match(/such as "([^"]+)"/)[1];
      expect(suggested).toBe('eng-smoke-claude-2');
      expect(suggested).not.toMatch(/47010/);
    });

    test('a long first word and a long proposed name still give a short name, and the counter survives', async () => {
      userLookup({ ...HUMANS, [HUMAN_INSTALLER]: { _id: HUMAN_INSTALLER, isBot: false, username: 'abcdefghijklmnopqrst' } });
      held(['uvwxyzabcdefghijklmnop'], { ownerHolds: ['abcdefghijkl-uvwxyzabcdef'] });
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'uvwxyzabcdefghijklmnop' }, summary: 'Connect' });
      const suggested = result.error.match(/such as "([^"]+)"/)[1];
      expect(suggested).toBe('abcdefghijkl-uvwxyzabcdef-2');
      expect(suggested.length).toBeLessThanOrEqual(27);
    });

    test('when every counter is taken, a three-hex tail still gives a name', async () => {
      held(['my-claude', 'sam-lee-claude', 'sam-lee-claude-2', 'sam-lee-claude-3', 'sam-lee-claude-4', 'sam-lee-claude-5']);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.error).toMatch(/such as "sam-lee-claude-[0-9a-f]{3}", which is free/);
    });

    test('a Codex proposal is named for Codex', async () => {
      held(['my-codex']);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-codex' }, summary: 'Connect' });
      expect(result.error).toContain('such as "sam-lee-codex", which is free');
    });

    test('with no owner record at all, the refusal still stands, without a suggestion', async () => {
      held(['my-claude']);
      mockUserFindById.mockImplementation(async (id) => (String(id) === HUMAN_INSTALLER ? null : HUMANS[String(id)] || null));
      mockUserFindById.mockImplementationOnce(async (id) => HUMANS[String(id)] || null);
      const result = await propose({ actionType: 'connect_local_agent', params: { name: 'my-claude' }, summary: 'Connect' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/pick a different name$/);
    });
  });

  test('a built-in agent name is refused at proposal time, before anyone is asked to approve it', async () => {
    const { reservedAgentNameRefusal } = require('../../../services/agentNameReservation');
    reservedAgentNameRefusal.mockResolvedValueOnce({
      code: 'agent_name_reserved',
      error: '"claude-code" is the name of a built-in agent. Choose a name of your own for this agent, such as "your-name-claude".',
    });
    podLookup(BOT_USER);
    installLookup({ installedBy: HUMAN_INSTALLER, foreignOwner: null });

    const result = await propose({
      actionType: 'connect_local_agent',
      params: { name: 'claude-code' },
      summary: 'Connect your Claude Code agent',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/built-in agent/);
    expect(reservedAgentNameRefusal).toHaveBeenCalledWith('claude-code');
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });
});
