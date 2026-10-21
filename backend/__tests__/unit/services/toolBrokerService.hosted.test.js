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
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => `Use a separate pod: ${reason}`),
}));
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
const { outsiderGrantPodRefusal } = require('../../../services/outsiderGrantPodEligibility');

const {
  callTool, listToolsForGrant, getToolDefinitions, allToolDefinitions, executeApprovedToolCall,
} = broker;
const currentWriteDigest = () => allToolDefinitions()
  .find((definition) => definition.name === 'linear.create_issue').definitionDigest;
// eslint-disable-next-line import/no-unresolved, import/extensions
const { digestArgs } = require('../../../models/ToolCall');
// eslint-disable-next-line import/no-unresolved, import/extensions
const projectionService = require('../../../services/grantBrokerProjectionService');

const {
  hostedBrokerToolsForRun, GRANT_BROKER_TOOL_NAME_PATTERN, sanitizeGrantBrokerToolName,
} = projectionService;
// eslint-disable-next-line import/no-unresolved, import/extensions
const { HostedMcpCredentialError } = require('../../../services/hostedMcpCredentialError');
// eslint-disable-next-line import/no-unresolved, import/extensions
const hostedEntries = require('../../../integrations/hostedMcp/entries');

const { HOSTED_MCP_ENTRIES } = hostedEntries;

const ROW_ID = 'a1b2c3d4e5f60718293a4b5c';
const POD_ID = 'b1b2c3d4e5f60718293a4b5c';
// The person the row belongs to. A real `createdBy` is an ObjectId written from
// the authenticated user id; the TASK-181 owner check reads this id, so a
// fixture with a placeholder would refuse every hosted call as an owner that
// cannot name an account.
const OWNER = '6a8f6de2a1dccf2e02f31459';
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
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    },
    {
      name: 'create_issue',
      upstreamName: 'createIssue',
      description: 'Create an issue',
      class: 'write',
      irreversible: true,
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
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

// The ledger row a refusal wrote. Read it off the mock rather than with
// `objectContaining`, because the property is present-and-undefined when no
// owner can be named, and that is a different claim from an absent one.
const refusedRow = () => mockToolCall.create.mock.calls
  .map(([row]) => row).find((row) => row.outcome === 'refused');

const hostedRow = (overrides = {}) => ({
  _id: ROW_ID,
  type: 'hosted-mcp',
  status: 'connected',
  createdBy: OWNER,
  createdAt: ROW_CREATED_AT,
  config: { entryId: 'linear', credentialRef: 'cred-1' },
  ...overrides,
});

const okReply = { jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text', text: 'done' }] } };
let upstreamTools;
const listReply = () => ({
  jsonrpc: '2.0', id: 'list-1',
  result: { tools: upstreamTools },
});
const sessionFetch = (answer) => jest.fn(async (url, init) => {
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  const body = JSON.parse(init.body);
  if (body.method === 'initialize') return new Response(JSON.stringify({
    jsonrpc: '2.0', id: body.id,
    result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
  }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' } });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  return answer(url, init);
});
const vendorFetch = (answer = async () => new Response(JSON.stringify(okReply), {
  status: 200, headers: { 'content-type': 'application/json' },
})) => sessionFetch(async (url, init) => {
  if (JSON.parse(init.body).method === 'tools/list') {
    return new Response(JSON.stringify(listReply()), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return answer(url, init);
});
const toolCalls = () => global.fetch.mock.calls.filter(([, init]) => (
  init.method === 'POST' && JSON.parse(init.body).method === 'tools/call'
));

// The shipped catalogue, kept so this suite can put it back: the fixtures below
// pin their own entry, and since step 7 the real Linear entry is a member of
// this array — a fixture PUSHED beside it would be shadowed by the shipped one
// (`findHostedMcpEntry` answers first-wins on the id both call `linear`), and
// every arm here would quietly run against the vendor instead of the stub it
// names.
const shippedEntries = [...HOSTED_MCP_ENTRIES];

beforeAll(() => {
  HOSTED_MCP_ENTRIES.length = 0;
  HOSTED_MCP_ENTRIES.push(ENTRY);
});

afterAll(() => {
  HOSTED_MCP_ENTRIES.length = 0;
  HOSTED_MCP_ENTRIES.push(...shippedEntries);
});

beforeEach(() => {
  jest.clearAllMocks();
  outsiderGrantPodRefusal.mockResolvedValue(null);
  upstreamTools = ENTRY.tools.map((tool) => ({
    name: tool.upstreamName, inputSchema: tool.inputSchema, annotations: tool.annotations,
  }));
  // The production cache is process-scoped; each fixture starts with a new
  // row assessment rather than inheriting another test's vendor answer.
  require('../../../services/hostedMcpToolDefinitions').forgetHostedMcpDrift(ROW_ID);
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockToolCall.create.mockResolvedValue(undefined);
  const row = hostedRow();
  // Through the query the models actually answer: `resolveHostedConnection` and
  // the tool's own row lookup both use `.lean()`.
  mockIntegration.findById.mockReturnValue({ ...row, lean: async () => row });
  mockIntegration.findOne.mockResolvedValue(null);
  // The owner row the TASK-181 check reads, in the chain it reads it:
  // `loadSessionAccount` -> `User.findById(id).select('banned isBot').lean()`.
  // Both fields are present because `sessionRefusal` reads them together and
  // treats `undefined` as neither — a projection missing one refuses nothing.
  mockUser.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ banned: false, isBot: false }) }),
  });
  mockCredentialFor.mockResolvedValue({ token: 'tok-1' });
  mockDmService.getOrCreateAgentRoom.mockResolvedValue({ _id: 'room-1' });
  global.fetch = vendorFetch();
});

describe('a hosted-MCP grant through the broker', () => {
  it.each([
    'pod_required', 'pod_not_private', 'pod_joinable', 'pod_bridged', 'non_native_agent', 'write_mode_unconfined',
  ])(
    'rechecks and refuses %s before a vendor call', async (reason) => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      outsiderGrantPodRefusal.mockResolvedValue(reason);
      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
      })).rejects.toMatchObject({ code: `outsider_grant_${reason}` });
      await expect(listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' }))
        .rejects.toMatchObject({ code: `outsider_grant_${reason}` });
      expect(toolCalls()).toHaveLength(0);
    },
  );

  it('refuses an undeclared top-level argument before vendor call or budget, recording only its digest', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({ budget: { calls: 3 } }));
    const args = { limit: 3, unexpected: 'private value' };

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'invalid_tool_args' });
    expect(toolCalls()).toHaveLength(0);
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(refusedRow()).toEqual(expect.objectContaining({
      outcome: 'refused', reason: 'invalid_tool_args', argsDigest: digestArgs(args),
    }));
    expect(JSON.stringify(refusedRow())).not.toContain('private value');
  });

  it('refuses an undeclared hosted write before parking an approval', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      tools: ['linear.create_issue'], writeMode: 'write-with-confirm',
    }));
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.create_issue',
      args: { title: 'x', unexpected: 'private value' },
    })).rejects.toMatchObject({ code: 'invalid_tool_args' });
    expect(mockProposeAction).not.toHaveBeenCalled();
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(toolCalls()).toHaveLength(0);
    expect(refusedRow().reason).toBe('invalid_tool_args');
  });

  it('refuses a changed upstream schema at call time and removes the pin from tools/list', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({ budget: { calls: 3 } }));
    upstreamTools[0] = {
      ...upstreamTools[0],
      inputSchema: { type: 'object', properties: { extra: { type: 'string' } } },
    };

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'tool_drift' });
    expect(toolCalls()).toHaveLength(0);
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'tool_drift', credentialOwnerId: OWNER,
    }));
    await expect(listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' }))
      .resolves.toEqual([]);
  });

  it('offers and calls a compatibly changed read under the pinned schema and logs one fresh assessment', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    upstreamTools[0] = {
      ...upstreamTools[0],
      inputSchema: {
        type: 'object', properties: { limit: { type: 'number' }, extra: { type: 'string' } },
      },
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listed = await listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' });
      expect(listed).toEqual([expect.objectContaining({
        name: 'linear.list_issues', inputSchema: ENTRY.tools[0].inputSchema,
      })]);
      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues',
        args: { limit: 3 }, hostedTurn: true,
      })).resolves.toMatchObject({ outcome: 'ok' });
      expect(JSON.parse(toolCalls()[0][1].body).params.arguments).toEqual({ limit: 3 });
      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues',
        args: { extra: 'unreviewed' }, hostedTurn: true,
      })).rejects.toMatchObject({ code: 'invalid_tool_args' });
      expect(toolCalls()).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('"verdict":"ok"');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a read pin when the vendor withdraws readOnlyHint', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    upstreamTools[0] = { ...upstreamTools[0], annotations: {} };
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'tool_drift' });
    expect(toolCalls()).toHaveLength(0);
  });

  it('fails a vendor 503 at tools/list as provider_error but still offers pinned tools', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    global.fetch = jest.fn(async () => new Response('', { status: 503 }));
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'provider_error' });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed', reason: 'provider_error',
    }));
    expect(toolCalls()).toHaveLength(0);
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'provider_error' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await expect(listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'linear.list_issues' })]));
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    'connection_mismatch',
    'reconnect_required',
    'credential_missing',
    'refresh_unreachable',
    'connection_error',
    'credential_refreshing',
  ])('still offers pinned tools when credential lookup reports %s', async (code) => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    mockCredentialFor.mockRejectedValue(new HostedMcpCredentialError(code, code));
    await expect(listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'linear.list_issues' })]));
    expect(mockCredentialFor).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['refresh_unreachable', 'credential_refreshing'])(
    'keeps %s as a failed call with its original credential reason', async (code) => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      mockCredentialFor.mockRejectedValue(new HostedMcpCredentialError(code, code));
      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
      })).rejects.toMatchObject({ code });
      expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'failed', reason: code,
      }));
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['reconnect_required', 'connection_mismatch'])(
    'trails a permanent %s credential failure as refused', async (code) => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      mockCredentialFor.mockRejectedValue(new HostedMcpCredentialError(code, code));
      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
      })).rejects.toMatchObject({ code });
      expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'refused', reason: code,
      }));
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('uses the call’s unreachable and rejected-credential reasons for a failed list', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'provider_unreachable' });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed', reason: 'provider_unreachable',
    }));
    expect(toolCalls()).toHaveLength(0);

    global.fetch = jest.fn(async () => new Response('', { status: 401 }));
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'credential_rejected' });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'credential_rejected',
    }));
    expect(toolCalls()).toHaveLength(0);
  });

  it('keeps reconnect_required when the row credential fails before tools/list', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    mockCredentialFor.mockRejectedValue(Object.assign(new Error('reconnect this row'), {
      code: 'reconnect_required',
    }));
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'reconnect_required',
    }));
  });

  it('assesses two rows on one entry with each row’s own credential and cache key', async () => {
    const otherId = 'b2b2c3d4e5f60718293a4b5c';
    mockRoomGrant.findOne.mockImplementation(async ({ grantId }) => hostedGrant({
      grantId,
      connectionId: grantId === 'grant-b' ? otherId : ROW_ID,
    }));
    mockIntegration.findById.mockImplementation((id) => ({
      lean: async () => hostedRow({ _id: id }),
    }));
    mockCredentialFor.mockImplementation(async (row) => ({
      token: row._id === otherId ? 'tok-b' : 'tok-a',
    }));
    global.fetch = sessionFetch(async (_url, init) => {
      const method = JSON.parse(init.body).method;
      const tools = init.headers.Authorization === 'Bearer tok-b'
        ? [{ ...upstreamTools[0], inputSchema: { type: 'object', properties: { extra: { type: 'string' } } } }, upstreamTools[1]]
        : upstreamTools;
      return new Response(JSON.stringify(method === 'tools/list'
        ? { jsonrpc: '2.0', id: 'list', result: { tools } }
        : okReply), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(callTool({
      grantId: 'grant-a', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).resolves.toBeTruthy();
    await expect(callTool({
      grantId: 'grant-b', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'tool_drift' });
    const lists = global.fetch.mock.calls.filter(([, init]) => (
      init.method === 'POST' && JSON.parse(init.body).method === 'tools/list'
    ));
    expect(lists).toHaveLength(2);
    expect(lists.map(([, init]) => init.headers.Authorization)).toEqual(['Bearer tok-a', 'Bearer tok-b']);
    require('../../../services/hostedMcpToolDefinitions').forgetHostedMcpDrift(otherId);
  });

  it('finds the hosted tool by name and runs it at the vendor', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const result = await callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.list_issues',
      args: { limit: 3 },
      hostedTurn: true,
    });

    expect(toolCalls()).toHaveLength(1);
    const [url, init] = toolCalls()[0];
    expect(url).toBe('https://mcp.linear.app/mcp');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(init.body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { limit: 3 } },
    });
    expect(result.result).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(result.outcome).toBe('ok');
    expect(result.untrustedSourceTitle).toBe('Linear');
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ok',
      // The hosted row's `createdBy` — the member whose credential the vendor saw.
      credentialOwnerId: OWNER,
    }));

    // The credential was read for THIS row, not for the grant id.
    expect(mockCredentialFor).toHaveBeenCalledWith(expect.objectContaining({ _id: ROW_ID }));
  });

  it('records a resolved vendor tool error as failed and returns its content unchanged', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const vendorError = {
      isError: true,
      content: [{ type: 'text', text: 'Google Calendar access is not enabled for this project.' }],
    };
    global.fetch = vendorFetch(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 'call-error', result: vendorError,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.list_issues',
      args: { limit: 3 },
      hostedTurn: true,
    });

    expect(result).toEqual(expect.objectContaining({ result: vendorError, outcome: 'failed' }));
    expect(result.untrustedSourceTitle).toBe('Linear');
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      reason: 'upstream_tool_error',
    }));
    expect(mockToolCall.create).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });

  it('records a provider HTTP failure as failed with its transport reason', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    global.fetch = vendorFetch(async () => new Response('', { status: 503 }));

    await expect(callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.list_issues',
      args: {},
      hostedTurn: true,
    })).rejects.toMatchObject({ code: 'provider_error' });

    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      reason: 'provider_error',
    }));
    expect(mockToolCall.create).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }));
  });

  it('persists no quoted JSON credential fields from a vendor 400', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    global.fetch = sessionFetch(async (_url, init) => {
      const method = JSON.parse(init.body).method;
      if (method === 'tools/list') return new Response(JSON.stringify({
        access_token: 'SECOND_ACCESS_SENTINEL',
        refresh_token: 'REFRESH_SENTINEL',
        client_secret: 'CLIENT_SECRET_SENTINEL',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(okReply), { headers: { 'content-type': 'application/json' } });
    });
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {}, hostedTurn: true,
    })).rejects.toMatchObject({ code: 'provider_error' });
    const [record] = mockToolCall.create.mock.calls[0];
    expect(record).toMatchObject({ outcome: 'failed', vendorStatus: 400 });
    expect(record.vendorError).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
  });

  it('excludes private fields from oversized JSON in direct and approved ToolCall writes', async () => {
    const body = JSON.stringify({ private_note: 'PRIVATE_BODY_SENTINEL', padding: 'x'.repeat(5000) });
    for (const approved of [false, true]) {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant(approved ? {
        tools: ['linear.create_issue'], writeMode: 'write-with-confirm',
      } : {}));
      global.fetch = sessionFetch(async (_url, init) => {
        if (JSON.parse(init.body).method === 'tools/list') {
          return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify(okReply), { headers: { 'content-type': 'application/json' } });
      });
      const args = approved ? { title: 'approved issue' } : {};
      const invocation = approved ? executeApprovedToolCall({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.create_issue', args,
        expectedArgsDigest: digestArgs(args), approvalId: 'approval-private-body',
      }) : callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args, hostedTurn: true,
      });
      await expect(invocation).rejects.toMatchObject({ code: 'provider_error' });
      const [record] = mockToolCall.create.mock.calls.at(-1);
      expect(record).toMatchObject({ outcome: 'failed', vendorStatus: 400 });
      expect(record.vendorError).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain('PRIVATE_BODY_SENTINEL');
    }
  });

  it('records a vendor tool error after owner approval as failed with its approval id', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      tools: ['linear.create_issue'],
      writeMode: 'write-with-confirm',
    }));
    const args = { title: 'approved issue' };
    const vendorError = {
      isError: true,
      content: [{ type: 'text', text: 'The vendor rejected this operation.' }],
    };
    global.fetch = vendorFetch(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 'call-error', result: vendorError,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await executeApprovedToolCall({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.create_issue',
      args,
      expectedArgsDigest: digestArgs(args),
      expectedDefinitionDigest: currentWriteDigest(),
      approvalId: 'approval-vendor-error',
    });

    expect(result).toEqual(expect.objectContaining({ result: vendorError, outcome: 'failed' }));
    expect(result.untrustedSourceTitle).toBe('Linear');
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      reason: 'upstream_tool_error',
      approvalId: 'approval-vendor-error',
    }));
    expect(mockToolCall.create).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });

  it('records an unreachable vendor after owner approval as failed with its transport reason', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      tools: ['linear.create_issue'],
      writeMode: 'write-with-confirm',
    }));
    const args = { title: 'approved issue' };
    global.fetch = vendorFetch(async () => { throw new Error('ECONNREFUSED'); });

    await expect(executeApprovedToolCall({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.create_issue',
      args,
      expectedArgsDigest: digestArgs(args),
      expectedDefinitionDigest: currentWriteDigest(),
      approvalId: 'approval-transport-error',
    })).rejects.toMatchObject({ code: 'provider_unreachable' });

    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      reason: 'provider_unreachable',
      approvalId: 'approval-transport-error',
    }));
    expect(mockToolCall.create).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }));
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
    // A record names the owner only once the row is PROVEN the grant's own.
    // This row carries `createdBy`, and still names nobody: the proof is what
    // makes the creator this call's credential owner.
    expect(refusedRow().credentialOwnerId).toBeUndefined();
  });

  it('refuses a grant that predates the row it names (TASK-148, unchanged for this type)', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({ createdAt: new Date('2025-12-31T00:00:00.000Z') }));

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({ code: 'connection_superseded' });
    expect(global.fetch).not.toHaveBeenCalled();
    // A superseded row is the re-added one, whose `createdBy` never made the
    // grant — so it is the case where reading the row's owner would be exactly
    // wrong. The owner check runs after this proof, never before it.
    expect(refusedRow().credentialOwnerId).toBeUndefined();
  });

  it('reports a vendor 401 as the credential being gone, after the call was made', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    global.fetch = vendorFetch(async () => new Response('', { status: 401 }));

    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
    })).rejects.toMatchObject({
      code: 'credential_rejected',
      message: expect.stringContaining('reconnect'),
    });
    expect(toolCalls()).toHaveLength(1);
    expect(mockCredentialFor).toHaveBeenCalledTimes(2);
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
      OWNER,
      expect.objectContaining({ agentName: 'openclaw' }),
    );
    expect(mockProposeAction).toHaveBeenCalledTimes(1);
    // A parked write is assessed by tools/list but never sends tools/call.
    expect(toolCalls()).toHaveLength(0);
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending_approval' }));
    // The parked envelope carries the owner, so the record the DECISION writes
    // still names it after the row is deleted.
    expect(mockProposeAction).toHaveBeenCalledWith(expect.objectContaining({
      toolCall: expect.objectContaining({ credentialOwnerId: OWNER, definitionDigest: expect.any(String) }),
    }));
  });

  const parkWrite = async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      tools: ['linear.create_issue'], writeMode: 'write-with-confirm',
    }));
    await expect(callTool({
      grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.create_issue', args: { title: 'x' },
    })).rejects.toMatchObject({ code: 'approval_required' });
    return mockProposeAction.mock.calls.at(-1)[0].toolCall;
  };

  const approveWrite = (parked) => executeApprovedToolCall({
    grantId: parked.grantId,
    agentUserId: 'agent-a',
    tool: parked.tool,
    args: parked.canonicalArgs,
    expectedArgsDigest: parked.argsDigest,
    expectedDefinitionDigest: parked.definitionDigest,
    approvalId: 'approval-1',
  });

  it('runs an unchanged hosted pin after approval', async () => {
    const parked = await parkWrite();
    await expect(approveWrite(parked)).resolves.toMatchObject({ outcome: 'ok' });
    expect(toolCalls()).toHaveLength(1);
  });

  it.each([
    ['name', 'renamed_issue'],
    ['upstreamName', 'createIssueV2'],
    ['description', 'Changed description'],
    ['class', 'read'],
    ['irreversible', false],
    ['inputSchema', { type: 'object', properties: { body: { type: 'string' } } }],
    ['annotations', { readOnlyHint: true, destructiveHint: false }],
    ['futurePinField', 'new policy'],
  ])('refuses an approved write when pin field %s changes', async (field, changed) => {
    const parked = await parkWrite();
    const pin = ENTRY.tools[1];
    const original = pin[field];
    pin[field] = changed;
    try {
      await expect(approveWrite(parked)).rejects.toMatchObject({ code: 'definition_digest_mismatch' });
      expect(toolCalls()).toHaveLength(0);
      expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
      expect(refusedRow()).toEqual(expect.objectContaining({
        reason: 'definition_digest_mismatch', approvalId: 'approval-1',
      }));
    } finally {
      if (original === undefined) delete pin[field];
      else pin[field] = original;
    }
  });

  it('binds a parked write to its catalogue entry id', async () => {
    const parked = await parkWrite();
    ENTRY.id = 'linear-repinned';
    try {
      await expect(approveWrite(parked)).rejects.toMatchObject({ code: 'definition_digest_mismatch' });
      expect(toolCalls()).toHaveLength(0);
    } finally {
      ENTRY.id = 'linear';
    }
  });

  it('refuses a pre-binding hosted approval without a definition digest', async () => {
    const parked = await parkWrite();
    delete parked.definitionDigest;
    await expect(approveWrite(parked)).rejects.toMatchObject({ code: 'definition_digest_mismatch' });
    expect(toolCalls()).toHaveLength(0);
  });

  it('refuses a hosted write whose grant target is invalid, keeping the cause\'s own code', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
      target: { kind: 'seat' },
      tools: ['linear.create_issue'],
      writeMode: 'write-with-confirm',
    }));

    // The cause is `resolveApprovalPodId`'s `invalid_target` (403), a permanent
    // refusal. The park path's catch used to relabel every cause
    // `approval_unavailable` (503) — a retryable verdict for something no retry
    // can fix, with the ledger recording a reason that was not the cause
    // (recorded on the row as an observation in slice 3c-2, fixed here). The
    // positive control is the sibling arm in `toolBrokerApprovalService.test.js`
    // ("records a refusal when the approval proposal throws"): a cause that is
    // NOT a `RoomGrantError` still reports `approval_unavailable`.
    //
    // Re-pointed when TASK-181's owner check landed: this arm used to reach
    // `resolveApprovalPodId`'s `connection_mismatch` through a row with no
    // `createdBy`, and the owner check now refuses that fixture earlier and more
    // specifically. The arm's subject — a permanent refusal keeps its own code —
    // is unchanged; only the cause it walks through moved.
    await expect(callTool({
      grantId: 'grant-hosted',
      agentUserId: 'agent-a',
      tool: 'linear.create_issue',
      args: { title: 'x' },
    })).rejects.toMatchObject({ code: 'invalid_target', statusCode: 403 });
    // The ledger reason is a code, and it is now the cause's own code.
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused',
      reason: 'invalid_target',
    }));
    expect(mockDmService.getOrCreateAgentRoom).not.toHaveBeenCalled();
    expect(mockProposeAction).not.toHaveBeenCalled();
    expect(toolCalls()).toHaveLength(0);
  });

  it('offers the hosted tool to the grant that names it, in both listing surfaces', async () => {
    mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
    const listed = await listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' });
    expect(listed.map((definition) => definition.name)).toEqual(['linear.list_issues']);
  });

  // TASK-181 §7: a hosted row is authorised by the PERSON who connected it, so a
  // suspension has to reach the credential and not only the sign-in. A banned
  // person cannot sign in, but an agent acting on their connection never signs in
  // as them — it presents its own runtime token and the broker spends the
  // credential they connected, so without this the ban stops the human and not
  // the authority. The predicate comes from `sessionAccountService`, the one
  // live-row read the session verifiers share, and each refusal names a
  // different remedy: lift the ban, or remove the row.
  describe('a hosted row whose owner is not a usable account', () => {
    const ownedRow = (owner) => {
      const row = hostedRow({ createdBy: owner });
      mockIntegration.findById.mockReturnValue({ ...row, lean: async () => row });
    };
    const ownerRow = (fields) => ({ select: () => ({ lean: async () => fields }) });
    it('refuses a call by a suspended owner, and never reaches the vendor', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(OWNER);
      mockUser.findById.mockReturnValue(ownerRow({ banned: true, isBot: false }));

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_banned', statusCode: 403 });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
      expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'refused',
        reason: 'connection_owner_banned',
      }));
      // The audit ask, not a second authority check: the guard refuses INSIDE
      // `resolveConnection`, and `callTool` fills its own owner only once that
      // returns — so without the id carried on the error, the one row whose
      // reason names the owner is the one row that does not say who they were.
      expect(refusedRow().credentialOwnerId).toBe(OWNER);
    });

    // The projection is why this code exists at all: a check written as
    // `select('banned')` reads `isBot` as `undefined` and refuses nothing, so a
    // bot-owned row stays callable. `sessionRefusal` reads both fields together.
    it('refuses a row owned by a bot account', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(OWNER);
      mockUser.findById.mockReturnValue(ownerRow({ banned: false, isBot: true }));

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_bot', statusCode: 403 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses when the owner row no longer exists', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(OWNER);
      mockUser.findById.mockReturnValue(ownerRow(null));

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_missing', statusCode: 403 });
      // The row is gone, but the row that said who owned it is not: the id is
      // what makes "whose connection was this" answerable after the fact.
      expect(refusedRow().credentialOwnerId).toBe(OWNER);
    });

    it('refuses a row with no owner at all without asking the database', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(undefined);

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_missing', statusCode: 403 });
      // The id-shape test is not the predicate: it keeps an uncastable value out
      // of `findById`, whose CastError would reach the caller as a 500.
      expect(mockUser.findById).not.toHaveBeenCalled();
      // And nothing is recorded as the owner: the column is read as an owner id,
      // and a malformed value names no account. Recording it would be a guess
      // dressed as a fact, which is worse than the blank.
      expect(refusedRow().credentialOwnerId).toBeUndefined();
    });

    // A non-empty value that is not an account id at all: refused as `missing`,
    // never looked up, and NOT written to the audit column. `'owner-1'` is the
    // value the merged fixtures used before TASK-181 needed a real owner.
    it('refuses a row whose owner value names no account, and records no owner', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow('owner-1');

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_missing', statusCode: 403 });
      expect(mockUser.findById).not.toHaveBeenCalled();
      expect(refusedRow().credentialOwnerId).toBeUndefined();
    });

    // The acceptance controls. A guard that refused every call would pass every
    // arm above, and a ban that never lifts is not the behaviour anyone asked
    // for: the plan says a lifted ban restores the grants with no reconnect.
    it('runs the same call when the owner is not suspended', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(OWNER);

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).resolves.toBeTruthy();
      expect(toolCalls()).toHaveLength(1);
    });

    it('reads the row it resolved, so a different owner is judged on every call', async () => {
      const other = '6a8f6de2a1dccf2e02f31460';
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(other);
      mockUser.findById.mockReturnValue(ownerRow({ banned: true, isBot: false }));

      await expect(callTool({
        grantId: 'grant-hosted', agentUserId: 'agent-a', tool: 'linear.list_issues', args: {},
      })).rejects.toMatchObject({ code: 'connection_owner_banned' });
      expect(mockUser.findById).toHaveBeenCalledWith(other);
    });

    // A list is not a call, so it writes no ledger row — but it must refuse,
    // because a capability disclosure that offers tools every call would reject
    // is the same lie in a quieter form.
    it('refuses the listing with the same code, and writes no row', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant());
      ownedRow(OWNER);
      mockUser.findById.mockReturnValue(ownerRow({ banned: true, isBot: false }));

      await expect(listToolsForGrant({ grantId: 'grant-hosted', agentUserId: 'agent-a' }))
        .rejects.toMatchObject({ code: 'connection_owner_banned', statusCode: 403 });
      expect(mockToolCall.create).not.toHaveBeenCalled();
    });

    // The check is read at call time, so a call approved after the ban refuses
    // too: `executeApprovedToolCall` resolves the connection again before it
    // spends anything.
    it('refuses an approved call whose owner was suspended after the park', async () => {
      mockRoomGrant.findOne.mockResolvedValue(hostedGrant({
        tools: ['linear.create_issue'],
        writeMode: 'write-with-confirm',
      }));
      ownedRow(OWNER);
      mockUser.findById.mockReturnValue(ownerRow({ banned: true, isBot: false }));

      await expect(executeApprovedToolCall({
        grantId: 'grant-hosted',
        agentUserId: 'agent-a',
        tool: 'linear.create_issue',
        args: { title: 'x' },
        expectedArgsDigest: digestArgs({ title: 'x' }),
        expectedDefinitionDigest: currentWriteDigest(),
        approvalId: 'approval-1',
      })).rejects.toMatchObject({ code: 'connection_owner_banned', statusCode: 403 });
      expect(global.fetch).not.toHaveBeenCalled();
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
