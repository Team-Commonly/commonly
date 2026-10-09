const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockUser = { findById: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockGithub = {
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
};
const mockReserveBudgetLineage = jest.fn();
const mockDmService = { getOrCreateAgentRoom: jest.fn() };

jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/User', () => ({ __esModule: true, default: mockUser }));
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
// The seat's own declaration is judged inside `callTool`/`listToolsForGrant`
// (TASK-175). This suite has no Mongo, so the RESOLUTION is mocked here and the
// resolution itself is witnessed on memory Mongo in
// `seatGrantConfinement.test.js` — this file witnesses where the check sits.
const mockSeatConfinement = jest.fn();
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: (...args) => mockSeatConfinement(...args),
}));
jest.mock('../../../services/githubAppService', () => mockGithub);
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
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
const { callTool } = require('../../../services/toolBrokerService');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { assertGrantUsable, getGrantLineage } = require('../../../services/roomGrantService');

// The row a grant was minted for always predates the grant; the guard compares
// these two, so both fixtures carry the field the models always write.
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');

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
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.close_issue', args: { issueNumber: 7 },
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'pending_approval', reason: 'approval_required',
    }));
    expect(mockGithub.closeIssue).not.toHaveBeenCalled();
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
