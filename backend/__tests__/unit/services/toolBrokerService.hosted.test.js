/**
 * A hosted-MCP grant, end to end through the broker: the seat's tool list, the
 * lookup, the connection, the parked write, and the vendor call.
 *
 * The injected-fetcher suite (`hostedMcpToolDefinitions.test.js`) witnesses the
 * transport. This one witnesses the WIRING — that a hosted tool name is found
 * at all (it used to refuse `tool_not_found` once it was offered, and before
 * that was never offered), that the connection resolves to the row whose entry
 * the definition came from, and that `ownerUserId` is what a parked write needs
 * to open an approval room.
 */
const mockRoomGrant = { findOne: jest.fn(), find: jest.fn() };
const mockPod = { findById: jest.fn(), find: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockUser = { findById: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockReserveBudgetLineage = jest.fn(async () => true);
const mockCredentialFor = jest.fn();
const mockDmService = { getOrCreateAgentRoom: jest.fn(async () => ({ _id: 'room-1' })) };
const mockProposeAction = jest.fn(async () => ({ ok: true, approvalId: 'approval-1' }));

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
jest.mock('../../../services/hostedMcpCredentialService', () => ({
  __esModule: true,
  credentialFor: (...args) => mockCredentialFor(...args),
}));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: jest.fn(async () => ({ refusal: null, scope: 'unbound' })),
}));
jest.mock('../../../services/dmService', () => mockDmService);
jest.mock('../../../services/approvalActionService', () => ({ proposeAction: (...a) => mockProposeAction(...a) }));
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400, details = undefined) {
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
      // `tool` is OPTIONAL: `listToolsForGrant` asserts the grant without naming
      // one and checks each tool through `assertGrantToolAllowed` instead.
      if (options.tool) {
        if (!(options.grant.tools || []).includes(options.tool)) {
          throw new MockRoomGrantError('tool_not_allowed', 'tool not allowed', 403);
        }
        const rank = { read: 0, 'write-with-confirm': 1, write: 2 };
        if (rank[options.requiredWriteMode] > rank[options.grant.writeMode]) {
          throw new MockRoomGrantError('write_mode_not_allowed', 'write mode is too weak', 403);
        }
      }
      return options.grant;
    }),
    // The per-tool rule, modelled rather than stubbed: `listToolsForGrant`
    // filters every definition through it, so a no-op mock would let the GitHub
    // tools into `allowed` and resolve a GitHub connection for a hosted grant.
    assertGrantToolAllowed: jest.fn((grant, { tool, requiredWriteMode }) => {
      if (!(grant.tools || []).includes(tool)) {
        throw new MockRoomGrantError('tool_not_allowed', 'tool not allowed', 403);
      }
      const rank = { read: 0, 'write-with-confirm': 1, write: 2 };
      if (rank[requiredWriteMode] > rank[grant.writeMode]) {
        throw new MockRoomGrantError('write_mode_not_allowed', 'write mode is too weak', 403);
      }
    }),
    getGrantLineage: jest.fn(async (grant) => [grant]),
  };
});

// One `require` per module, each with the resolution directive on the line the
// rules actually report (a multi-line destructuring moves the `require` away
// from the comment and the suppression stops applying).
// eslint-disable-next-line import/no-unresolved, import/extensions
const broker = require('../../../services/toolBrokerService');

const {
  callTool, listToolsForGrant, getToolDefinitions, allToolDefinitions,
} = broker;
// eslint-disable-next-line import/no-unresolved, import/extensions
const projectionService = require('../../../services/grantBrokerProjectionService');

const {
  hostedBrokerToolsForRun, GRANT_BROKER_TOOL_NAME_PATTERN, sanitizeGrantBrokerToolName,
} = projectionService;
// eslint-disable-next-line import/no-unresolved, import/extensions
const hostedEntries = require('../../../integrations/hostedMcp/entries');

const { HOSTED_MCP_ENTRIES } = hostedEntries;

const ROW_ID = 'a1b2c3d4e5f60718293a4b5c';
const POD_ID = 'b1b2c3d4e5f60718293a4b5c';
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');
const ROW_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

const ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read'],
  revoke: 'https://mcp.linear.app/revoke',
  tools: [
    {
      name: 'list_issues',
      upstreamName: 'list_issues',
      description: 'List issues',
      class: 'read',
      inputSchema: { type: 'object' },
    },
    {
      name: 'create_issue',
      upstreamName: 'createIssue',
      description: 'Create an issue',
      class: 'write',
      irreversible: true,
      inputSchema: { type: 'object' },
    },
  ],
};

const hostedGrant = (overrides = {}) => ({
  grantId: 'grant-hosted',
  target: { kind: 'seat', id: 'agent-a' },
  tools: ['linear.list_issues'],
  writeMode: 'read',
  connectionId: ROW_ID,
  audience: ['agent-a'],
  expiresAt: new Date(Date.now() + 60000),
  createdAt: GRANT_CREATED_AT,
  ...overrides,
});

const hostedRow = (overrides = {}) => ({
  _id: ROW_ID,
  type: 'hosted-mcp',
  status: 'connected',
  createdBy: 'owner-1',
  createdAt: ROW_CREATED_AT,
  config: { entryId: 'linear', credentialRef: 'cred-1' },
  ...overrides,
});

const okReply = { jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text', text: 'done' }] } };

beforeAll(() => {
  HOSTED_MCP_ENTRIES.push(ENTRY);
});

afterAll(() => {
  HOSTED_MCP_ENTRIES.length = 0;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockToolCall.create.mockResolvedValue(undefined);
  const row = hostedRow();
  // Through the query the models actually answer: `resolveHostedConnection` and
  // the tool's own row lookup both use `.lean()`.
  mockIntegration.findById.mockReturnValue({ ...row, lean: async () => row });
  mockIntegration.findOne.mockResolvedValue(null);
  // The owner row the ban guard reads, in the chain it reads it:
  // `User.findById(id).select('banned').lean()`. A fixture whose `createdBy` is
  // not an id shape never reaches this (see the github suite's boundary arm).
  mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned: false }) }) });
  mockCredentialFor.mockResolvedValue({ token: 'tok-1' });
  mockDmService.getOrCreateAgentRoom.mockResolvedValue({ _id: 'room-1' });
  global.fetch = jest.fn(async () => new Response(JSON.stringify(okReply), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
});

describe('a hosted-MCP grant through the broker', () => {
  it('finds the hosted tool by name and runs it at the vendor', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const result = await callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.list_issues',
      args: { limit: 3 },
      hostedTurn: true,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://mcp.linear.app/mcp');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(init.body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { limit: 3 } },
    });
    expect(result.result).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ok',
      // The hosted row's `createdBy` — the member whose credential the vendor saw.
      credentialOwnerId: 'owner-1',
    }));

    // The credential was read for THIS row, not for the grant id.
    expect(mockCredentialFor).toHaveBeenCalledWith(expect.objectContaining({ _id: ROW_ID }));
  });

  it('refuses when the row names another entry, and never reaches the vendor', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const wrong = hostedRow({ config: { entryId: 'sentry', credentialRef: 'cred-1' } });
    mockIntegration.findById.mockReturnValue({ ...wrong, lean: async () => wrong });

    // The MESSAGE, not just the code: the tool's own call refuses the same
    // mismatch one layer down, so only naming the layer says which guard fired.
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({
      code: 'connection_mismatch',
      message: "grant connection does not belong to this tool's entry",
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockCredentialFor).not.toHaveBeenCalled();
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
  });

  it('refuses a row that is not connected, and a row that is gone', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const broken = hostedRow({ status: 'error' });
    mockIntegration.findById.mockReturnValue({ ...broken, lean: async () => broken });
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(global.fetch).not.toHaveBeenCalled();

    mockIntegration.findById.mockReturnValue({ lean: async () => null });
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a row with no creation timestamp, because that is the row the guard exists for', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const undated = hostedRow({ createdAt: undefined });
    mockIntegration.findById.mockReturnValue({ ...undated, lean: async () => undated });

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_untracked' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a grant that predates the row it names (TASK-148, unchanged for this type)', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({ createdAt: new Date('2025-12-31T00:00:00.000Z') }));

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_superseded' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports a vendor 401 as the credential being gone, after the call was made', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    global.fetch = jest.fn(async () => new Response('', { status: 401 }));

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({
      code: 'credential_rejected',
      message: expect.stringContaining('reconnect'),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockCredentialFor).toHaveBeenCalledTimes(1);
  });

  it('parks a hosted write with the row owner, which is what opens the approval room', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      tools: ['linear.create_issue'],
      writeMode: 'write-with-confirm',
    }));

    await expect(callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      agentName: 'openclaw',
      instanceId: 'aria',
      tool: 'linear.create_issue',
      args: { title: 'x' },
    })).rejects.toMatchObject({ code: 'approval_required' });

    expect(mockDmService.getOrCreateAgentRoom).toHaveBeenCalledWith(
      'agent-a',
      'owner-1',
      expect.objectContaining({ agentName: 'openclaw' }),
    );
    expect(mockProposeAction).toHaveBeenCalledTimes(1);
    // A parked write is not a call: nothing was sent to the vendor.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending_approval' }));
    // The parked envelope carries the owner, so the record the DECISION writes
    // still names it after the row is deleted.
    expect(mockProposeAction).toHaveBeenCalledWith(expect.objectContaining({
      toolCall: expect.objectContaining({ credentialOwnerId: 'owner-1' }),
    }));
  });

  it('refuses a hosted write whose row names no owner as a connection mismatch, not a retryable card failure', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      tools: ['linear.create_issue'],
      writeMode: 'write-with-confirm',
    }));
    const orphan = hostedRow({ createdBy: undefined });
    mockIntegration.findById.mockReturnValue({ ...orphan, lean: async () => orphan });

    // The cause is `ownerUserId` being absent, which `resolveApprovalPodId`
    // refuses as a permanent `connection_mismatch` (403). The park path's catch
    // used to relabel every cause `approval_unavailable` (503) — a retryable
    // verdict for something no retry can fix, with the ledger recording a
    // reason that was not the cause (recorded on the row as an observation in
    // slice 3c-2, fixed here). The positive control is the sibling arm in
    // `toolBrokerApprovalService.test.js` ("records a refusal when the approval
    // proposal throws"): a cause that is NOT a `RoomGrantError` still reports
    // `approval_unavailable`.
    await expect(callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.create_issue',
      args: { title: 'x' },
    })).rejects.toMatchObject({ code: 'connection_mismatch', statusCode: 403 });
    // The ledger reason is a code, and it is now the cause's own code.
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused',
      reason: 'connection_mismatch',
    }));
    expect(mockDmService.getOrCreateAgentRoom).not.toHaveBeenCalled();
    expect(mockProposeAction).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('offers the hosted tool to the grant that names it, in both listing surfaces', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const listed = await listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' });
    expect(listed.map((definition) => definition.name)).toEqual(['linear.list_issues']);
  });

  // TASK-181: a suspended person cannot sign in, but their agent never signs in
  // as them — it presents its own runtime token and spends the credential they
  // connected. Without this the ban stops the human and not the authority.
  describe('a connection whose owner is suspended', () => {
    const OWNER = '6a8f6de2a1dccf2e02f31459';

    const ownedRow = (banned) => {
      const row = hostedRow({ createdBy: OWNER });
      mockIntegration.findById.mockReturnValue({ ...row, lean: async () => row });
      mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ banned }) }) });
    };

    it('refuses the call and never reaches the vendor', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(true);

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_banned', statusCode: 403 });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'refused',
        reason: 'connection_owner_banned',
      }));
    });

    it('refuses the listing too, because a list answers what calling would allow', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(true);

      await expect(listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' }))
        .rejects.toMatchObject({ code: 'connection_owner_banned' });
    });

    it('runs the same call once the owner is not suspended', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(false);

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).resolves.toBeTruthy();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  it('projects the hosted tool into a run\'s tool list, under a name LiteLLM accepts', async () => {
    mockRoomGrant.find.mockReturnValue({
      select: () => ({ lean: async () => [hostedGrant({ brokerId: 'grant-broker' })] }),
    });
    mockPod.find.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: POD_ID, members: ['agent-a'] }] }),
    });

    const projection = await hostedBrokerToolsForRun({ identityId: 'agent-a', podId: POD_ID });
    const exposed = sanitizeGrantBrokerToolName('linear.list_issues');
    expect(exposed).toBe('linear_list_issues');
    expect(GRANT_BROKER_TOOL_NAME_PATTERN.test(exposed)).toBe(true);
    expect(projection.tools.map((tool) => tool.function.name)).toEqual(['linear_list_issues']);
    expect(projection.dispatch.get('linear_list_issues')).toEqual({
      grantId: 'grant-hosted',
      tool: 'linear.list_issues',
    });
  });

  it('keeps the GitHub record GitHub-only, so a hosted name cannot pass a GitHub-only gate', () => {
    // The positive half of the pair above: the hosted definition is in the
    // combined source and NOT in the record `toolInstallables` validates against.
    expect(getToolDefinitions().map((definition) => definition.name)).not.toContain('linear.list_issues');
    expect(allToolDefinitions().map((definition) => definition.name)).toContain('linear.list_issues');
    expect(getToolDefinitions().every((definition) => definition.connectionType === 'github-app')).toBe(true);
  });

  it('does not offer a hosted write tool in a run\'s list, even when the grant could name it', async () => {
    mockRoomGrant.find.mockReturnValue({
      select: () => ({
        lean: async () => [hostedGrant({
          tools: ['linear.create_issue'],
          writeMode: 'write-with-confirm',
          brokerId: 'grant-broker',
        })], 
      }),
    });
    mockPod.find.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: POD_ID, members: ['agent-a'] }] }),
    });

    const projection = await hostedBrokerToolsForRun({ identityId: 'agent-a', podId: POD_ID });
    expect(projection.tools).toEqual([]);
    expect(projection.dispatch.size).toBe(0);
  });
});
