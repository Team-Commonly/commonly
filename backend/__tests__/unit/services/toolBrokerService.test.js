const { createHash } = require('crypto');

const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockUser = { findById: jest.fn(), find: jest.fn() };
const mockOwnsRuntimeIdentity = jest.fn();
const mockToolCall = { create: jest.fn() };
const mockGithub = {
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
  createPullRequest: jest.fn(),
  createPullReview: jest.fn(),
  getPullRequest: jest.fn(),
};
const mockReserveBudgetLineage = jest.fn();
const mockPushSeatBranch = jest.fn();
const mockDmService = { getOrCreateAgentRoom: jest.fn() };

jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/User', () => ({ __esModule: true, default: mockUser }));
jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ownsRuntimeIdentity: (...args) => mockOwnsRuntimeIdentity(...args),
}));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: mockToolCall,
  // eslint-disable-next-line global-require
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: mockReserveBudgetLineage,
}));
jest.mock('../../../services/approvalActionService', () => ({
  proposeAction: jest.fn().mockResolvedValue({ ok: true, approvalId: 'approval-test' }),
}));
jest.mock('../../../services/dmService', () => mockDmService);
const mockRecordBrokerCall = jest.fn();
jest.mock('../../../services/brokerRecordService', () => ({ recordBrokerCall: (...args) => mockRecordBrokerCall(...args) }));
// The seat's own declaration is judged inside `callTool`/`listToolsForGrant`
// (TASK-175). This suite has no Mongo, so the RESOLUTION is mocked here and the
// resolution itself is witnessed on memory Mongo in
// `seatGrantConfinement.test.js` — this file witnesses where the check sits.
const mockSeatConfinement = jest.fn();
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: (...args) => mockSeatConfinement(...args),
}));
jest.mock('../../../services/githubAppService', () => mockGithub);
jest.mock('../../../services/seatGithubPush', () => ({
  SeatPushError: class SeatPushError extends Error {
    constructor(code, statusCode = 403) { super(code); this.code = code; this.statusCode = statusCode; }
  },
  parseSeatPushArgs: jest.fn(),
  pushSeatBranch: (...args) => mockPushSeatBranch(...args),
}));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => `Use a separate pod: ${reason}`),
}));
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400, details) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.details = details;
    }
  }
  return {
    RoomGrantError: MockRoomGrantError,
    assertGrantUsable: jest.fn(async (options) => {
      if (options.grant.revokedAt) throw new MockRoomGrantError('grant_revoked', 'grant revoked', 403);
      if (!options.currentMemberIds.includes(options.agentUserId)) {
        throw new MockRoomGrantError('not_in_audience', 'agent is not in the grant audience', 403);
      }
      if (!(options.grant.tools || []).includes(options.tool)) {
        throw new MockRoomGrantError('tool_not_allowed', 'tool not allowed', 403);
      }
      const rank = { read: 0, 'write-with-confirm': 1, write: 2 };
      if (rank[options.requiredWriteMode] > rank[options.grant.writeMode]) {
        throw new MockRoomGrantError('write_mode_not_allowed', 'write mode is too weak', 403);
      }
      return options.grant;
    }),
    getGrantLineage: jest.fn(async (grant) => [grant]),
  };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const {
  callTool, executeApprovedToolCall, executionErrorOutcome, getToolDefinitions,
} = require('../../../services/toolBrokerService');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { assertGrantUsable, getGrantLineage, RoomGrantError } = require('../../../services/roomGrantService');
const { outsiderGrantPodRefusal } = require('../../../services/outsiderGrantPodEligibility');

// The row a grant was minted for always predates the grant; the guard compares
// these two, so both fixtures carry the field the models always write.
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');
const digest = (args) => createHash('sha256').update(JSON.stringify(args)).digest('hex');

const seatGrant = (overrides = {}) => ({
  grantId: 'grant-1',
  installationId: 'install-1',
  target: { kind: 'seat', id: 'agent-a' },
  tools: ['github.create_issue'],
  writeMode: 'read',
  connectionId: 'connection-1',
  audience: ['agent-a'],
  expiresAt: new Date(Date.now() + 60000),
  createdAt: GRANT_CREATED_AT,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  // A lineage set by one test must not leak into the next: the broker now
  // reads it on every GitHub call (TASK-783's prWrite rule).
  getGrantLineage.mockImplementation(async (grant) => [grant]);
  mockSeatConfinement.mockResolvedValue({ refusal: null, scope: 'unbound' });
  mockToolCall.create.mockResolvedValue(undefined);
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected',
    createdBy: 'owner-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockIntegration.findById.mockResolvedValue(null);
  // An owner row exists and is not banned unless an arm says otherwise. The
  // shape is the real chain: `User.findById(id).select('banned').lean()`.
  mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned: false }) }) });
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockGithub.listOpenIssues.mockResolvedValue([]);
  mockGithub.getPullRequest.mockResolvedValue({ number: 12, head: { sha: 'a'.repeat(40) } });
  mockGithub.createIssue.mockResolvedValue({
    number: 1,
    title: 'test',
    html_url: 'https://github.com/Team-Commonly/commonly/issues/1',
  });
  mockDmService.getOrCreateAgentRoom.mockResolvedValue({ _id: 'room-1' });
});

describe('tool broker guard rails', () => {
  it('takes required write mode from the server tool definition, never request input', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant());
    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      tool: 'github.create_issue',
      args: { title: 'nope', writeMode: 'write' },
    })).rejects.toMatchObject({ code: 'write_mode_not_allowed' });
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused',
      reason: 'write_mode_not_allowed',
      agentUserId: 'agent-a',
    }));
  });

  it('refuses the call when the CALLING seat cannot confine the broker (TASK-175)', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockSeatConfinement.mockResolvedValue({
      refusal: {
        code: 'grant_broker_unconfined',
        decidedBy: 'server',
        reason: 'adapter_cannot_confine',
        detail: "the seat runs the 'pi' adapter, which confines on no host",
      },
      scope: 'seat',
    });

    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      agentName: 'openclaw',
      instanceId: 'aria',
      tool: 'github.list_issues',
      args: {},
    })).rejects.toMatchObject({
      code: 'grant_broker_unconfined',
      statusCode: 403,
      // The shared catch appends the trail id; the predicate's own `reason`
      // travels on `details` and is asserted where the real error class is used
      // (seatGrantConfinement.test.js, whose first arm checks it).
      details: expect.objectContaining({ callId: expect.any(String) }),
    });

    // Judged for the caller the token names, not for the grant.
    expect(mockSeatConfinement).toHaveBeenCalledWith({
      agentName: 'openclaw', instanceId: 'aria', agentUserId: 'agent-a',
    });
    // A refusal is not a spendable call, and it IS trailed — the two things that
    // say the check sits before the work rather than after it.
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      grantId: 'grant-1',
      outcome: 'refused',
      reason: 'grant_broker_unconfined',
    }));
  });

  describe('F94: an agent the grant names, outside Commonly', () => {
    const unconfined = {
      refusal: {
        code: 'grant_broker_unconfined', decidedBy: 'server', reason: 'sandbox_trust_not_public', detail: 'workspace trust',
      },
      scope: 'seat',
    };
    beforeEach(() => {
      mockUser.find.mockReturnValue({
        select: () => ({ lean: async () => [{ _id: 'agent-a', botMetadata: { agentName: 'lily-claude', instanceId: 'default' } }] }),
      });
      mockOwnsRuntimeIdentity.mockResolvedValue({ owned: true });
    });
    const named = (over = {}) => seatGrant({
      ownerId: 'owner-1',
      tools: ['github.list_issues'],
      byoAgents: ['agent-a'],
      byoConsent: { by: 'owner-1', at: new Date(), version: 'byo-v1', agents: [{ userId: 'agent-a', sandbox: 'unconfined' }] },
      ...over,
    });
    const call = () => callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', agentName: 'lily-claude', instanceId: 'default',
      tool: 'github.list_issues', args: {},
    });

    it('runs the call for a named agent the server cannot confine, and records that it ran unconfined', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named());
      mockSeatConfinement.mockResolvedValue(unconfined);
      await expect(call()).resolves.toMatchObject({ outcome: 'ok' });
      expect(mockGithub.listOpenIssues).toHaveBeenCalled();
      expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'ok', agentUserId: 'agent-a', callerConfinement: 'named_unconfined',
      }));
    });

    it('passes only the named agents to the pod gate', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named());
      mockSeatConfinement.mockResolvedValue(unconfined);
      await call();
      expect(outsiderGrantPodRefusal).toHaveBeenCalledWith(
        { kind: 'seat', id: 'agent-a' }, 'read', { exemptAgentIds: ['agent-a'] },
      );
    });

    it('stops naming the agent once someone else also installs it, from the next call', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named());
      mockSeatConfinement.mockResolvedValue(unconfined);
      mockOwnsRuntimeIdentity.mockResolvedValue({ owned: false, failure: 'another_installer' });
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
      expect(mockOwnsRuntimeIdentity).toHaveBeenCalledWith('owner-1', 'lily-claude', 'default');
      expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    });

    it('drops an agent that is no longer solely owned from the pod-gate exemption', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named());
      mockSeatConfinement.mockResolvedValue({ refusal: null, scope: 'seat' });
      mockOwnsRuntimeIdentity.mockResolvedValue({ owned: false, failure: 'another_installer' });
      await call().catch(() => {});
      expect(outsiderGrantPodRefusal).toHaveBeenCalledWith(
        { kind: 'seat', id: 'agent-a' }, 'read', { exemptAgentIds: [] },
      );
    });

    it('exempts the consented agent at the pod gate for a child grant scoped away from it', async () => {
      // A hosted member attenuated a child for itself: the child names nobody,
      // but the named agent still shares the pod under the lineage's consent.
      mockRoomGrant.findOne.mockResolvedValue(named({ byoAgents: [], audience: ['hosted-h'] }));
      mockSeatConfinement.mockResolvedValue({ refusal: null, scope: 'seat' });
      await call().catch(() => {});
      expect(outsiderGrantPodRefusal).toHaveBeenCalledWith(
        { kind: 'seat', id: 'agent-a' }, 'read', { exemptAgentIds: ['agent-a'] },
      );
    });

    it('does not lift for an agent the child grant no longer names', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named({ byoAgents: [] }));
      mockSeatConfinement.mockResolvedValue(unconfined);
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
    });

    it('never lifts for an agent the consent recorded as confined, whose seat no longer confines', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named({
        byoConsent: { by: 'owner-1', at: new Date(), version: 'byo-v1', agents: [{ userId: 'agent-a', sandbox: 'confined' }] },
      }));
      mockSeatConfinement.mockResolvedValue(unconfined);
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
    });

    it('names nobody when the consent was not the granter\'s', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named({
        byoConsent: { by: 'someone-else', at: new Date(), version: 'byo-v1', agents: [{ userId: 'agent-a', sandbox: 'unconfined' }] },
      }));
      mockSeatConfinement.mockResolvedValue(unconfined);
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
    });

    it('names nobody without the consent record, so the agent is refused as before', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named({ byoConsent: undefined }));
      mockSeatConfinement.mockResolvedValue(unconfined);
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
      expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
      expect(outsiderGrantPodRefusal).not.toHaveBeenCalled();
    });

    it('does not lift the refusal for an agent the grant does not name', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named({ byoAgents: ['agent-b'], audience: ['agent-a', 'agent-b'] }));
      mockSeatConfinement.mockResolvedValue(unconfined);
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
      expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    });

    it('never lifts the refusal of a machine with no enforceable sandbox', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named());
      mockSeatConfinement.mockResolvedValue({ ...unconfined, hostUnconfined: true });
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
      expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    });

    it('never lifts the refusal of an adapter not approved for the broker', async () => {
      mockRoomGrant.findOne.mockResolvedValue(named());
      mockSeatConfinement.mockResolvedValue({ refusal: { ...unconfined.refusal, reason: 'adapter_cannot_confine' }, scope: 'seat' });
      await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
      expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    });

    it('records a confined caller as confined', async () => {
      mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
      mockSeatConfinement.mockResolvedValue({ refusal: null, scope: 'seat' });
      await call();
      expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ callerConfinement: 'confined' }));
    });
  });

  it('refuses a grant whose connection is not a connected GitHub App row', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockIntegration.findOne.mockResolvedValue({
      type: 'github-app', status: 'disconnected',
      config: { installationId: 'gh-install-1', owner: 'attacker', repo: 'repo' },
    });
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
  });

  // TASK-148. The guard is a comparison, so the control has to be a call that
  // SUCCEEDS: a row older than its grant is the normal state, and a guard that
  // refused it would take the broker offline for every seat.
  it('resolves a grant whose connection row predates it', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).resolves.toBeDefined();
    expect(mockGithub.listOpenIssues).toHaveBeenCalled();
  });

  // The re-add: the same installation id comes back as a NEW row, so
  // `resolveConnection`'s installationId lookup finds a row young enough to
  // postdate the grant that was minted for the deleted one.
  it('refuses a grant that predates the connection row it resolves to', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockIntegration.findOne.mockResolvedValue({
      type: 'github-app',
      status: 'connected',
      createdBy: 'owner-2',
      createdAt: new Date(GRANT_CREATED_AT.getTime() + 60000),
      config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
    });
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_superseded' });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused',
      reason: 'connection_superseded',
    }));
  });

  // Fail closed, on BOTH sides. A guard written as `a && b && c` would pass
  // every row whose timestamp is absent — which is exactly the population that
  // cannot be shown to belong to the grant.
  it.each([
    ['the grant', { createdAt: undefined }],
    ['the connection row', null],
    ['a non-Date timestamp on the grant', { createdAt: '2026-01-02T00:00:00.000Z' }],
  ])('refuses when %s carries no readable creation timestamp', async (_label, grantOverride) => {
    mockRoomGrant.findOne.mockResolvedValue(
      grantOverride === null
        ? seatGrant({ tools: ['github.list_issues'] })
        : seatGrant({ tools: ['github.list_issues'], ...grantOverride }),
    );
    if (grantOverride === null) {
      mockIntegration.findOne.mockResolvedValue({
        type: 'github-app',
        status: 'connected',
        createdBy: 'owner-1',
        createdAt: undefined,
        config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
      });
    }
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_untracked' });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
  });

  it('loads pod membership fresh for every grant usability assertion', async () => {
    const grant = seatGrant({
      grantId: 'pod-grant',
      target: { kind: 'pod', id: 'pod-1' },
      tools: ['github.list_issues'],
      writeMode: 'read',
      audience: ['agent-a'],
    });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    let lookup = 0;
    mockPod.findById.mockImplementation(() => ({
      select: () => ({
        lean: async () => {
          lookup += 1;
          return { members: lookup === 1 ? ['agent-a'] : ['agent-b'] };
        },
      }),
    }));

    await expect(callTool({
      grantId: 'pod-grant', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    }))
      .resolves.toEqual(expect.objectContaining({ result: { issues: [] } }));
    await expect(callTool({
      grantId: 'pod-grant', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    }))
      .rejects.toMatchObject({ code: 'not_in_audience' });
    expect(mockPod.findById).toHaveBeenCalledTimes(2);
    expect(assertGrantUsable).toHaveBeenCalledTimes(2);
  });

  it('writes one trail row with token identity when the body names another agent', async () => {
    const grant = seatGrant({ tools: ['github.close_issue'], writeMode: 'write' });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    await callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.close_issue',
      args: { title: 'x', agentUserId: 'agent-b' },
    }).catch(() => {});
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      agentUserId: 'agent-a',
      outcome: 'refused',
      reason: 'invalid_tool_args',
      // A refusal that happened AFTER the connection resolved still names whose
      // credential it would have spent (plan §8).
      credentialOwnerId: 'owner-1',
    }));
  });

  it('refuses a tool outside the allow-list and records the refusal', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.get_issue'] }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'tool_not_allowed', agentUserId: 'agent-a',
    }));
  });

  it('refuses an agent outside the effective audience', async () => {
    const grant = seatGrant({
      grantId: 'pod-grant', target: { kind: 'pod', id: 'pod-1' }, tools: ['github.list_issues'],
    });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    mockPod.findById.mockImplementation(() => ({
      select: () => ({ lean: async () => ({ members: ['agent-b'] }) }),
    }));
    await expect(callTool({
      grantId: 'pod-grant', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'not_in_audience' });
  });

  it('refuses after revoke without a process restart', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ revokedAt: new Date() }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'grant_revoked' });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
  });

  it('never returns a provider credential in any tool result', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockGithub.listOpenIssues.mockResolvedValue([{
      number: 1, title: 'safe', html_url: 'https://github.com/x/y/1', body: '', access_token: 'credential',
    }]);
    const response = await callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    });
    expect(JSON.stringify(response.result)).not.toContain('credential');
  });

  it('allows calls: 3 three times and refuses the fourth', async () => {
    const grant = seatGrant({ tools: ['github.list_issues'], budget: { calls: 3 } });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    mockReserveBudgetLineage
      .mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {} })).resolves.toBeTruthy();
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {} })).resolves.toBeTruthy();
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {} })).resolves.toBeTruthy();
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {} })).rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('draws down a parent budget before the child budget', async () => {
    const parent = seatGrant({ grantId: 'root-grant', budget: { calls: 10 } });
    const child = seatGrant({ grantId: 'child-grant', parentGrantId: 'root-grant', budget: { calls: 3 }, tools: ['github.list_issues'] });
    mockRoomGrant.findOne.mockResolvedValue(child);
    getGrantLineage.mockResolvedValue([child, parent]);
    await callTool({ grantId: 'child-grant', agentUserId: 'agent-a', tool: 'github.list_issues', args: {} });
    expect(mockReserveBudgetLineage).toHaveBeenCalledWith([
      { grantId: 'root-grant', calls: 10, windowMs: undefined },
      { grantId: 'child-grant', calls: 3, windowMs: undefined },
    ]);
  });

  it('parks irreversible writes for approval without spending budget', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.create_issue'], writeMode: 'write-with-confirm', budget: { calls: 1 },
    }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.create_issue', args: { title: 'needs approval' },
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending_approval', reason: 'approval_required' }));
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
  });

  it('parks an irreversible tool under a write grant', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.create_issue'], writeMode: 'write', budget: { calls: 1 },
    }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.create_issue', args: { title: 'needs approval' },
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'pending_approval', reason: 'approval_required',
    }));
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
  });

  it('a write grant runs a reversible write unattended', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.close_issue'], writeMode: 'write',
    }));
    mockGithub.closeIssue.mockResolvedValue({
      number: 7, title: 'closed', html_url: 'https://github.com/Team-Commonly/commonly/issues/7',
      state: 'closed',
    });
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.close_issue', args: { issueNumber: 7 },
    })).resolves.toEqual(expect.objectContaining({
      result: expect.objectContaining({ number: 7, title: 'closed' }),
    }));
    expect(mockGithub.closeIssue).toHaveBeenCalledTimes(1);
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });

  it('records whose credential ran, from the connection rather than the caller', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    await callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      agentUserId: 'agent-a',
      credentialOwnerId: 'owner-1',
      outcome: 'ok',
    }));

    // The owner follows the ROW it resolved, not the calling seat and not a
    // constant: a second connection answers with its own creator.
    mockToolCall.create.mockClear();
    mockIntegration.findOne.mockResolvedValue({
      type: 'github-app',
      status: 'connected',
      createdBy: 'owner-2',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
    });
    await callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      credentialOwnerId: 'owner-2',
    }));
  });

  it('copies bounded vendor diagnostics into the failed call trail', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockGithub.listOpenIssues.mockRejectedValue(new RoomGrantError(
      'provider_error', 'vendor refused', 502,
      { vendorStatus: 400, vendorError: `session required\n${'private detail'.repeat(30)}` },
    ));
    const call = callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    });
    await expect(call).rejects.toMatchObject({ code: 'provider_error' });
    await expect(call).rejects.not.toHaveProperty('details.vendorError');
    await expect(call).rejects.not.toHaveProperty('details.vendorStatus');
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed', reason: 'provider_error', vendorStatus: 400, vendorError: 'session required',
    }));
  });

  it('leaves the owner unset when the refusal IS the connection resolution', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockIntegration.findOne.mockResolvedValue(null);
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_mismatch' });
    // No connection resolved, so there is no credential to name — recorded as an
    // absent owner rather than a guess at the grant's row.
    const [record] = mockToolCall.create.mock.calls[0];
    expect(record.outcome).toBe('refused');
    expect(record.credentialOwnerId).toBeUndefined();
  });

  it('parks a reversible write under a write-with-confirm grant', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.close_issue'], writeMode: 'write-with-confirm', budget: { calls: 1 },
    }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.close_issue',
      runId: 'aaaaaaaaaaaaaaaaaaaaa111', runPodId: 'bbbbbbbbbbbbbbbbbbbbb111', args: { issueNumber: 7 },
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'pending_approval', reason: 'approval_required',
    }));
    expect(mockGithub.closeIssue).not.toHaveBeenCalled();
    expect(require('../../../services/approvalActionService').proposeAction).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'aaaaaaaaaaaaaaaaaaaaa111', runPodId: 'bbbbbbbbbbbbbbbbbbbbb111',
    }));
  });
});

// TASK-181 §7: the owner check is HOSTED ONLY. A `github-app` row's token
// belongs to the app installation, not to the admin who created the row, so a
// suspension must not disable the app connector for every pod holding a grant on
// it. Pinned beside the exclusion so a later reader sees it is deliberate rather
// than a call site someone forgot.
describe('a suspended github-app row owner (§7)', () => {
  const OWNER = '6a8f6de2a1dccf2e02f31459';

  it('leaves the call alone, and reads no owner row at all', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.list_issues'] }));
    mockIntegration.findOne.mockResolvedValue({
      type: 'github-app',
      status: 'connected',
      createdBy: OWNER,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
    });
    mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned: true }) }) });

    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    })).resolves.toBeTruthy();
    expect(mockGithub.listOpenIssues).toHaveBeenCalledTimes(1);
    expect(mockUser.findById).not.toHaveBeenCalled();
  });
});

// TASK-560: every committed trail row reaches the record once, as the same call.
describe('record wiring', () => {
  const recorded = () => {
    expect(mockRecordBrokerCall).toHaveBeenCalledTimes(mockToolCall.create.mock.calls.length);
    const [row] = mockRecordBrokerCall.mock.calls[0];
    const [trail] = mockToolCall.create.mock.calls[0];
    expect(row).toMatchObject({ callId: trail.callId, outcome: trail.outcome, grantId: trail.grantId, tool: trail.tool, agentUserId: 'agent-a' });
    return row;
  };

  it('a refusal', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.get_issue'] }));
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.list_issues', args: {} }))
      .rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(recorded().outcome).toBe('refused');
  });

  it('a park, with its card and the credential owner', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.create_issue'], writeMode: 'write-with-confirm' }));
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.create_issue', args: { title: 'x' } }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(recorded()).toMatchObject({ outcome: 'pending_approval', approvalId: 'approval-test', credentialOwnerId: 'owner-1' });
  });

  it('an unattended run, with the grant it ran under', async () => {
    const grant = seatGrant({ tools: ['github.close_issue'], writeMode: 'write' });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    mockGithub.closeIssue.mockResolvedValue({ number: 7, title: 'closed', html_url: 'https://github.com/x/y/issues/7', state: 'closed' });
    await callTool({ grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.close_issue', args: { issueNumber: 7 } });
    const row = recorded();
    expect(row.outcome).toBe('ok');
    expect(row.approvalId).toBeUndefined();
    expect(row.grant).toBe(grant);
  });
});

describe('host GitHub command tools', () => {
  const cases = [
    {
      tool: 'github.create_pull_request',
      args: { title: 'Change', head: 'seat/agent-a/change', base: 'main' },
      method: 'createPullRequest',
      result: { number: 12, title: 'Change', html_url: 'https://github.com/Team-Commonly/commonly/pull/12' },
      expected: { title: 'Change', head: 'seat/agent-a/change', base: 'main' },
    },
    {
      tool: 'github.comment_on_pull_request',
      args: { pullNumber: 12, body: 'Please check this' },
      method: 'addIssueComment',
      result: { id: 42, html_url: 'https://github.com/Team-Commonly/commonly/pull/12#issuecomment-42' },
      expected: { issueNumber: 12, body: 'Please check this' },
    },
    {
      tool: 'github.review_pull_request_comment',
      args: { pullNumber: 12, body: 'Inline feedback' },
      method: 'createPullReview',
      result: { id: 43, html_url: 'https://github.com/Team-Commonly/commonly/pull/12#pullrequestreview-43' },
      expected: { pullNumber: 12, body: 'Inline feedback', event: 'COMMENT' },
    },
  ];

  it.each(cases)('$tool parks before provider use, then executes only with App auth', async ({
    tool, args, method, result, expected,
  }) => {
    // TASK-783: opening a PR needs the grant's pull-request access.
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: [tool], writeMode: 'write', ...(tool === 'github.create_pull_request' ? { prWrite: true } : {}),
    }));
    mockGithub[method].mockResolvedValue(result);
    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      tool,
      args,
    }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(mockGithub[method]).not.toHaveBeenCalled();

    const approvedArgs = { ...args, owner: 'Team-Commonly', repo: 'commonly' };
    await expect(executeApprovedToolCall({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      tool,
      args: approvedArgs,
      expectedArgsDigest: digest(approvedArgs),
      approvalId: 'approval-test',
      // TASK-783: a PR write is judged again against how its caller was parked.
      callerConfinement: 'confined',
    })).resolves.toMatchObject({ outcome: 'ok' });
    expect(mockGithub[method]).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'Team-Commonly',
      repo: 'commonly',
      installationId: 'gh-install-1',
      forceApp: true,
      ...expected,
    }));
  });

  it('refuses a PR comment on a plain issue before posting', async () => {
    // The issue-comment endpoint accepts issues too, so a PR-comment grant
    // must not reach one. GitHub answers 404 on /pulls/:n for an issue.
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.comment_on_pull_request'], writeMode: 'write',
    }));
    mockGithub.getPullRequest.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    const args = { pullNumber: 7, body: 'hi', owner: 'Team-Commonly', repo: 'commonly' };
    await expect(executeApprovedToolCall({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      tool: 'github.comment_on_pull_request',
      args,
      expectedArgsDigest: digest(args),
      approvalId: 'approval-test',
    })).rejects.toMatchObject({ code: 'not_a_pull_request' });
    expect(mockGithub.getPullRequest).toHaveBeenCalledWith(expect.objectContaining({ pullNumber: 7, forceApp: true }));
    expect(mockGithub.addIssueComment).not.toHaveBeenCalled();
  });

  it('refuses an ungranted PR write before provider use', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.get_pull_request'], writeMode: 'write',
    }));
    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      tool: 'github.create_pull_request',
      args: { title: 'Change', head: 'seat/agent-a/change', base: 'main' },
    })).rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(mockGithub.createPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a sibling PR branch before proposing and again at approved execution', async () => {
    const args = { title: 'Change', head: 'seat/agent-b/work', base: 'main' };
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.create_pull_request'], writeMode: 'write', prWrite: true,
    }));
    await expect(callTool({ grantId: 'grant-1', agentUserId: 'agent-a',
      tool: 'github.create_pull_request', args })).rejects.toMatchObject({ code: 'branch_not_owned_by_seat' });
    const approvedArgs = { ...args, owner: 'Team-Commonly', repo: 'commonly' };
    await expect(executeApprovedToolCall({ grantId: 'grant-1', agentUserId: 'agent-a',
      tool: 'github.create_pull_request', args: approvedArgs,
      expectedArgsDigest: digest(approvedArgs), approvalId: 'approval-test', callerConfinement: 'confined' }))
      .rejects.toMatchObject({ code: 'branch_not_owned_by_seat' });
    expect(mockGithub.createPullRequest).not.toHaveBeenCalled();
  });
});

describe('the seat push tool stays off until the server enables it', () => {
  const args = {
    ref: 'refs/heads/seat/agent-a/work', baseOid: 'a'.repeat(40),
    newOid: 'b'.repeat(40), bundle: 'YWJj',
  };
  afterEach(() => { delete process.env.SEAT_GITHUB_PUSH_ENABLED; });

  it('is neither offered nor grantable while the flag is unset', () => {
    delete process.env.SEAT_GITHUB_PUSH_ENABLED;
    expect(getToolDefinitions().map((d) => d.name)).not.toContain('github.push_branch');
    process.env.SEAT_GITHUB_PUSH_ENABLED = 'true';
    expect(getToolDefinitions().map((d) => d.name)).toContain('github.push_branch');
  });

  it.each([undefined, '1', 'TRUE'])('refuses a pinned push on an autonomous write grant when the flag is %s', async (value) => {
    if (value === undefined) delete process.env.SEAT_GITHUB_PUSH_ENABLED;
    else process.env.SEAT_GITHUB_PUSH_ENABLED = value;
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode: 'write' }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args,
    })).rejects.toMatchObject({ code: 'tool_not_found' });
    expect(mockPushSeatBranch).not.toHaveBeenCalled();
  });

  it('refuses a push approved while the flag was on once it is off', async () => {
    delete process.env.SEAT_GITHUB_PUSH_ENABLED;
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode: 'write' }));
    await expect(executeApprovedToolCall({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args,
      expectedArgsDigest: digest(args), approvalId: 'approval-test',
    })).rejects.toMatchObject({ code: 'tool_not_found' });
    expect(mockPushSeatBranch).not.toHaveBeenCalled();
  });
});

describe('host GitHub push authority', () => {
  const args = {
    ref: 'refs/heads/seat/agent-a/work', baseOid: 'a'.repeat(40),
    newOid: 'b'.repeat(40), bundle: 'YWJj',
  };
  beforeEach(() => { process.env.SEAT_GITHUB_PUSH_ENABLED = 'true'; });
  afterEach(() => { delete process.env.SEAT_GITHUB_PUSH_ENABLED; });

  it('refuses read mode before an App push', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode: 'read', prWrite: true }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args,
    })).rejects.toMatchObject({ code: 'write_mode_not_allowed' });
    expect(mockPushSeatBranch).not.toHaveBeenCalled();
  });

  // TASK-783: a push is a PR write. It needs the grant's pull-request access,
  // and it parks for the owner whatever the grant's mode.
  it('refuses a push on a grant without pull-request access', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode: 'write-with-confirm' }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args,
    })).rejects.toMatchObject({ code: 'pr_write_not_granted' });
    expect(mockPushSeatBranch).not.toHaveBeenCalled();
  });

  it.each(['write-with-confirm', 'write'])('parks a push on a %s grant before any App push', async (writeMode) => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode, prWrite: true }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args,
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(mockPushSeatBranch).not.toHaveBeenCalled();
  });

  it('requires an explicit push pin even on an autonomous write grant', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.comment_on_issue'], writeMode: 'write' }));
    await expect(callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args,
    })).rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(mockPushSeatBranch).not.toHaveBeenCalled();
  });

  const approvedArgs = { ...args, owner: 'Team-Commonly', repo: 'commonly' };
  const runApproved = () => executeApprovedToolCall({
    grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.push_branch', args: approvedArgs,
    expectedArgsDigest: digest(approvedArgs), approvalId: 'approval-test', callerConfinement: 'confined',
  });

  it('binds the executing seat identity and uses the pinned App repository', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode: 'write-with-confirm', prWrite: true }));
    mockPushSeatBranch.mockResolvedValue({ ref: args.ref, oldOid: '0'.repeat(40), newOid: args.newOid });
    await expect(runApproved()).resolves.toMatchObject({ outcome: 'ok' });
    expect(mockPushSeatBranch).toHaveBeenCalledWith(args, expect.objectContaining({
      owner: 'Team-Commonly', repo: 'commonly', installationId: 'gh-install-1',
    }), 'agent-a');
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'github.push_branch', providerRef: args.ref, outcome: 'ok', approvalId: 'approval-test',
    }));
  });

  // An approved push spends the per-seat and per-grant push budget when it runs.
  // The per-token line has no token to key on there: a person approved it.
  it('shares a mandatory two-call budget across approved pushes', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ tools: ['github.push_branch'], writeMode: 'write-with-confirm', prWrite: true }));
    mockPushSeatBranch.mockResolvedValue({ ref: args.ref, oldOid: '0'.repeat(40), newOid: args.newOid });
    const spent = new Map();
    mockReserveBudgetLineage.mockImplementation(async (entries) => {
      if (entries.some(({ grantId, calls }) => (spent.get(grantId) || 0) >= calls)) return false;
      entries.forEach(({ grantId }) => spent.set(grantId, (spent.get(grantId) || 0) + 1));
      return true;
    });
    await expect(runApproved()).resolves.toMatchObject({ outcome: 'ok' });
    await expect(runApproved()).resolves.toMatchObject({ outcome: 'ok' });
    await expect(runApproved()).rejects.toMatchObject({ code: 'host_github_push_rate_limited', statusCode: 429 });
    expect(mockPushSeatBranch).toHaveBeenCalledTimes(2);
    expect(mockReserveBudgetLineage.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: expect.stringMatching(/^host-gh:push:seat:/), calls: 2 }),
      expect.objectContaining({ grantId: expect.stringMatching(/^host-gh:push:grant:/), calls: 2 }),
    ]));
  });

  it('records push policy errors as refusals and provider errors as failures', () => {
    const { SeatPushError } = require('../../../services/seatGithubPush');
    expect(executionErrorOutcome(new SeatPushError('non_fast_forward', 409))).toBe('refused');
    expect(executionErrorOutcome(new SeatPushError('provider_git_failed', 502))).toBe('failed');
  });
});
