/* eslint-disable global-require, import/no-unresolved, import/extensions --
   the requires must follow jest.mock, and this corpus resolves TS through the TS parser */
/**
 * The credential a hosted call presents never reaches the agent, even when the
 * vendor repeats it (TASK-297; the witness ADR-033 R1 asks for).
 *
 * The vendor is a stub MCP server that echoes the bearer token it was sent. It
 * reads the value off the request's Authorization header, so what it repeats is
 * the credential this call actually presented rather than a constant this file
 * also knows. It repeats it in a tool result that succeeded and in one with
 * `isError`, in the places a real reply carries text: a content item, nested
 * `structuredContent`, an object key, and a JSON string escape that only
 * decodes to the value after parsing.
 *
 * Everything between that vendor and the agent is real: the hosted tool
 * definition, the broker, and both ways an agent reaches a hosted tool.
 *   - The MCP grant route (`routes/mcpGrants.ts`), read as the raw HTTP reply
 *     the seat's MCP client receives.
 *   - A native run (`nativeRuntimeService.runAgent` through
 *     `dispatchHostedBrokerTool`), read as the whole next request the runtime
 *     sends the model.
 * Only storage, the credential store and the model endpoint are stubbed.
 *
 * The approval path is the third broker caller, and it is not here because it
 * returns no vendor content at all: an approved call leaves only its numeric
 * receipt (`approvedCallReceipt`).
 */
const express = require('express');
const request = require('supertest');

// Production vendor requests go through the outbound guard; it is mapped back
// to the stub at global.fetch, read at call time (as toolBrokerService.hosted does).
jest.mock('../../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: (...args) => global.fetch(...args),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...args) => mockAxiosPost(...args) } }));

// One answer for every query shape the two callers use: awaited directly
// (`RoomGrant.findOne`), or through `.select()` / `.lean()` chains.
const query = (value) => Object.assign(Promise.resolve(value), {
  select: () => query(value),
  lean: () => query(value),
});

const mockModels = {
  user: { find: jest.fn(), findOne: jest.fn(), findById: jest.fn() },
  pod: { find: jest.fn(), findById: jest.fn() },
  grant: { find: jest.fn(), findOne: jest.fn() },
  integration: { findById: jest.fn(), findOne: jest.fn() },
};
// Both module shapes: the runtime reaches these through CommonJS `require`,
// the broker and the projection through a default import.
const bothShapes = (model) => ({ __esModule: true, default: model, ...model });
jest.mock('../../../models/User', () => bothShapes(mockModels.user));
jest.mock('../../../models/Pod', () => bothShapes(mockModels.pod));
jest.mock('../../../models/RoomGrant', () => bothShapes(mockModels.grant));
jest.mock('../../../models/Integration', () => bothShapes(mockModels.integration));

const mockToolCallCreate = jest.fn();
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: { create: (...args) => mockToolCallCreate(...args) },
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: async () => true,
}));
jest.mock('../../../models/AgentRun', () => ({
  create: jest.fn(),
  countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));

const mockCredentialFor = jest.fn();
jest.mock('../../../services/hostedMcpCredentialService', () => ({
  __esModule: true,
  credentialFor: (...args) => mockCredentialFor(...args),
}));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: async () => null,
  outsiderGrantRefusalMessage: (reason) => reason,
}));
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: async () => ({ refusal: null, scope: 'unbound' }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: async () => false,
}));
jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));
// Grant lifecycle is not what this file witnesses; the audience and tool
// checks are modelled so a grant that does not name the tool still refuses.
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400, details = undefined) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.details = details;
    }
  }
  const allowed = (grant, tool) => {
    if (!(grant.tools || []).includes(tool)) throw new MockRoomGrantError('tool_not_allowed', 'tool not allowed', 403);
  };
  return {
    RoomGrantError: MockRoomGrantError,
    assertGrantUsable: async (options) => {
      if (!options.currentMemberIds.includes(options.agentUserId)) {
        throw new MockRoomGrantError('not_in_audience', 'agent is not in the grant audience', 403);
      }
      if (options.tool) allowed(options.grant, options.tool);
      return options.grant;
    },
    assertGrantToolAllowed: (grant, { tool }) => allowed(grant, tool),
    getGrantLineage: async (grant) => [grant],
  };
});

const POD = '507f1f77bcf86cd799439011';
const SEAT = '507f1f77bcf86cd799439013';
const ROW_ID = 'a1b2c3d4e5f60718293a4b5c';
const OWNER = '6a8f6de2a1dccf2e02f31459';

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = {
    _id: '507f1f77bcf86cd799439013',
    username: 'scout',
    botMetadata: { agentName: 'scout', instanceId: 'default' },
  };
  req.agentInstallation = { agentName: 'scout', instanceId: 'default' };
  next();
});

const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { forgetHostedMcpDrift } = require('../../../services/hostedMcpToolDefinitions');
const { runAgent } = require('../../../services/nativeRuntimeService');
const mcpGrantsRouter = require('../../../routes/mcpGrants');

// A realistic OAuth access token: long, and not shaped like anything the
// refusal path's generic patterns would also catch on their own.
const TOKEN = 'lin_oauth_8f3Kq2Zr9VxT1mWb7NcY4pLd6HsJ0aEu';

const ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read'],
  revoke: 'https://mcp.linear.app/revoke',
  tools: [{
    name: 'list_issues',
    upstreamName: 'list_issues',
    description: 'List issues',
    class: 'read',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  }],
};

const GRANT = {
  grantId: 'grant-hosted',
  target: { kind: 'seat', id: SEAT },
  audience: [SEAT],
  tools: ['linear.list_issues'],
  writeMode: 'read',
  connectionId: ROW_ID,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
};

const ROW = {
  _id: ROW_ID,
  type: 'hosted-mcp',
  status: 'connected',
  createdBy: OWNER,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  config: { entryId: 'linear', credentialRef: 'cred-1' },
};

/**
 * What the vendor puts in its tools/call result, given the token it was sent.
 * `l` is the token's first character as a JSON escape: the bytes on the
 * wire do not contain the value, and only the parsed string does.
 */
const echoingResult = (kind, sent) => {
  const escaped = `\\u006c${sent.slice(1)}`;
  const body = {
    content: [{ type: 'text', text: `Authorization: Bearer ${sent}` }],
    structuredContent: { request: { headers: { authorization: `Bearer ${sent}` } }, [sent]: 'seen' },
    ...(kind === 'isError' ? { isError: true } : {}),
  };
  return JSON.stringify(body).replace('"seen"', `"${escaped}"`);
};

// tools/call answers in the shape `wire` names: one JSON body, or one SSE event.
const replyFor = (wire, id, resultJson) => {
  const frame = `{"jsonrpc":"2.0","id":${id},"result":${resultJson}}`;
  return wire === 'sse'
    ? new Response(`event: message\ndata: ${frame}\n\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
    : new Response(frame, { status: 200, headers: { 'content-type': 'application/json' } });
};

let presented;
const echoingVendor = ({ kind, wire }) => jest.fn(async (url, init) => {
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  const body = JSON.parse(init.body);
  const json = (value) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' },
  });
  if (body.method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      },
    });
  }
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method === 'tools/list') {
    return json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: ENTRY.tools.map((tool) => ({
          name: tool.upstreamName, inputSchema: tool.inputSchema, annotations: tool.annotations,
        })),
      },
    });
  }
  const sent = new Headers(init.headers).get('authorization').replace(/^Bearer /, '');
  presented = sent;
  if (kind === 'rpcError') {
    return json({
      jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `token ${sent} is not valid for this workspace` },
    });
  }
  if (kind === 'httpError') {
    return new Response(`upstream rejected Bearer ${sent}`, { status: 500, headers: { 'content-type': 'text/plain' } });
  }
  return replyFor(wire, body.id, echoingResult(kind, sent));
});

const toolCallTurn = {
  status: 200,
  data: {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'linear_list_issues', arguments: '{"limit":3}' },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  },
  headers: {},
};
const finalTurn = {
  status: 200,
  data: {
    choices: [{ message: { role: 'assistant', content: 'Done.' } }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  },
  headers: {},
};

const INSTALLATION = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'] },
};

/** The bytes a seat's MCP client receives for one tools/call through the grant route. */
const throughMcpRoute = async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp/grants', mcpGrantsRouter);
  const response = await request(app)
    .post(`/api/mcp/grants/${GRANT.grantId}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'linear.list_issues', arguments: { limit: 3 } },
    });
  expect(response.status).toBe(200);
  return response.text;
};

/** The next request a native run sends the model, after the broker tool returned. */
const throughNativeRun = async () => {
  mockAxiosPost.mockResolvedValueOnce(toolCallTurn).mockResolvedValueOnce(finalTurn);
  await runAgent(INSTALLATION, {
    type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'what is open?' },
  });
  expect(mockAxiosPost).toHaveBeenCalledTimes(2);
  const next = mockAxiosPost.mock.calls[1][1];
  // The tool message must exist, or "the token is absent" would be true of a
  // run whose broker call never happened.
  expect(next.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1')).toBe(true);
  return JSON.stringify(next);
};

const CALLERS = [['the MCP grant route', throughMcpRoute], ['a native run', throughNativeRun]];

const shippedEntries = [...HOSTED_MCP_ENTRIES];
beforeAll(() => {
  HOSTED_MCP_ENTRIES.length = 0;
  HOSTED_MCP_ENTRIES.push(ENTRY);
  process.env.LITELLM_BASE_URL = 'http://litellm.test';
  process.env.LITELLM_MASTER_KEY = 'test-key';
});
afterAll(() => {
  HOSTED_MCP_ENTRIES.length = 0;
  HOSTED_MCP_ENTRIES.push(...shippedEntries);
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_MASTER_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  presented = undefined;
  forgetHostedMcpDrift(ROW_ID);
  mockCredentialFor.mockResolvedValue({ token: TOKEN });
  mockToolCallCreate.mockResolvedValue(undefined);
  mockModels.grant.findOne.mockImplementation(() => query(GRANT));
  mockModels.grant.find.mockImplementation(() => query([GRANT]));
  mockModels.integration.findById.mockImplementation(() => query(ROW));
  mockModels.integration.findOne.mockImplementation(() => query(null));
  mockModels.user.findById.mockImplementation(() => query({ banned: false, isBot: false }));
  mockModels.user.findOne.mockImplementation(() => query({ _id: SEAT }));
  mockModels.user.find.mockImplementation(() => query([{ _id: SEAT }]));
  mockModels.pod.findById.mockImplementation(() => query({ name: 'Launch Room', members: [SEAT] }));
  mockModels.pod.find.mockImplementation(() => query([{ _id: POD, members: [SEAT] }]));
  require('../../../models/AgentRun').create
    .mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn() }));
});

describe('a credential the vendor echoes in its tool result', () => {
  describe.each(CALLERS)('through %s', (_caller, through) => {
    it.each([
      ['a result that succeeded', 'success', 'json'],
      ['a result that succeeded, sent as SSE', 'success', 'sse'],
      ['an isError result', 'isError', 'json'],
      ['an isError result, sent as SSE', 'isError', 'sse'],
    ])('is absent from %s', async (_label, kind, wire) => {
      global.fetch = echoingVendor({ kind, wire });
      const received = await through();

      // The vendor saw the credential, so it had something to echo.
      expect(presented).toBe(TOKEN);
      expect(received).not.toContain(TOKEN);
      // The rest of the vendor's reply still arrived, with the value marked.
      expect(received).toContain('Authorization: Bearer [redacted]');
      if (kind === 'isError') expect(received).toContain('isError');
    });
  });
});

// Already covered before TASK-297 (`sanitizeVendorError` and
// `stripVendorDiagnostics`); pinned here so every way a vendor's words leave
// the broker is witnessed through both callers, not only the result.
describe('a credential the vendor echoes in a refusal', () => {
  describe.each(CALLERS)('through %s', (_caller, through) => {
    it.each([
      ['a JSON-RPC error', 'rpcError'],
      ['an HTTP 500 body', 'httpError'],
    ])('is absent from %s', async (_label, kind) => {
      global.fetch = echoingVendor({ kind, wire: 'json' });
      const received = await through();

      expect(presented).toBe(TOKEN);
      expect(received).not.toContain(TOKEN);
      expect(received).toContain('provider_error');
      // A JSON-RPC message is passed on, scrubbed; an HTTP body is never passed on.
      if (kind === 'rpcError') expect(received).toContain('token [redacted] is not valid for this workspace');
    });
  });
});
