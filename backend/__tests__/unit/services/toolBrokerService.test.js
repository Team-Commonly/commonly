const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockGithub = {
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
};
const mockReserveBudgetLineage = jest.fn();

jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: mockToolCall,
  // eslint-disable-next-line global-require
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: mockReserveBudgetLineage,
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

const seatGrant = (overrides = {}) => ({
  grantId: 'grant-1',
  installationId: 'install-1',
  target: { kind: 'seat', id: 'agent-a' },
  tools: ['github.create_issue'],
  writeMode: 'read',
  connectionId: 'connection-1',
  audience: ['agent-a'],
  expiresAt: new Date(Date.now() + 60000),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockToolCall.create.mockResolvedValue(undefined);
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected',
    config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockIntegration.findById.mockResolvedValue(null);
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockGithub.listOpenIssues.mockResolvedValue([]);
  mockGithub.createIssue.mockResolvedValue({
    number: 1,
    title: 'test',
    html_url: 'https://github.com/Team-Commonly/commonly/issues/1',
  });
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
    const grant = seatGrant({ tools: ['github.create_issue'], writeMode: 'write' });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    await callTool({
      grantId: 'grant-1', agentUserId: 'agent-a', tool: 'github.create_issue',
      args: { title: 'x', agentUserId: 'agent-b' },
    }).catch(() => {});
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      agentUserId: 'agent-a',
      outcome: 'refused',
      reason: 'invalid_tool_args',
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
});
