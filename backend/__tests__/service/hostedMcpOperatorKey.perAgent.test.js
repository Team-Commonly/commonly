/**
 * TASK-330: an operator key is ONE agent's bearer. These arms run the real
 * broker, the real native hosted turn, the real credential service and the real
 * ConnectorSecret store on a real Mongo; only the model (LiteLLM, via
 * axios.post) and the vendor's network edge (hostedVendorFetch) are stubbed.
 *
 *  1. per-agent offer   — only the seat the key is bound to and granted for is
 *                          offered the vendor's tool, read off its own model call.
 *  2. per-agent bearer  — each seat's call reaches the vendor carrying its OWN
 *                          key, and never the other seat's.
 *  3. leave empties it  — after the bound seat leaves the pod (the product's
 *                          removeAgentFromPod), its run offers no vendor tool.
 */
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

process.env.CONNECTOR_SECRET_KEYS = `opkey-test:${Buffer.alloc(32, 5).toString('base64')}`;
process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'opkey-test';

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn(),
}));
jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../../services/agentComputerBroker', () => ({ agentComputerBroker: {}, agentComputerEnabled: false }));
// The ToolCall ledger lives in PostgreSQL, which this tier does not run; the
// same in-memory stand-in teammate-approval.test.js uses. It decides nothing:
// the budget always admits, and the rows are only read back as a trail.
const mockLedger = [];
jest.mock('../../models/ToolCall', () => ({
  create: jest.fn(async (row) => { mockLedger.push(row); }),
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: jest.fn(async () => true),
}));
// The vendor's network edge. Every hosted-MCP request (tools/list for drift,
// tools/call for the call) goes through this one module.
const mockVendorRequests = [];
jest.mock('../../services/hostedVendorFetch', () => ({
  hostedVendorFetch: (...args) => mockVendorServer(...args),
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
}));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const RoomGrant = require('../../models/RoomGrant');
const AgentRun = require('../../models/AgentRun');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Integration = require('../../models/Integration');
const ConnectorSecret = require('../../models/ConnectorSecret');
const connectorSecrets = require('../../services/connectorSecrets');
const { HOSTED_MCP_ACCESS_TOKEN } = require('../../services/connectorSecretKinds');
const { secretWriteGeneration } = require('../../services/hostedMcpSecretGeneration');
const { HOSTED_MCP_ENTRIES, assertHostedMcpEntries } = require('../../integrations/hostedMcp/entries');
const { runAgent } = require('../../services/nativeRuntimeService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const AgentIdentityService = require('../../services/agentIdentityService');
const axios = require('axios').default;

jest.setTimeout(60000);

const READ_TOOL = {
  name: 'list_jobs',
  upstreamName: 'list_jobs',
  description: 'List the jobs this key can see',
  class: 'read',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
};
const WRITE_TOOL = {
  name: 'cancel_job',
  upstreamName: 'cancel_job',
  description: 'Cancel a job',
  class: 'write',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
};
const ENTRY = {
  id: 'keyvendor',
  title: 'Key Vendor',
  resource: 'https://mcp.keyvendor.example/mcp',
  credentialMode: 'operator_key',
  revoke: { page: 'https://keyvendor.example/settings/keys' },
  tools: [READ_TOOL, WRITE_TOOL],
};
const READ_NAME = 'keyvendor.list_jobs';
const READ_FUNCTION = 'keyvendor_list_jobs';

const json = (body, headers = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json', ...headers },
});
// A Streamable-HTTP MCP server that answers the four messages the broker sends
// and records the bearer on every request, whatever its method.
async function mockVendorServer(url, init = {}) {
  const auth = new Headers(init.headers).get('authorization');
  if (init.method === 'DELETE') {
    mockVendorRequests.push({ auth, method: 'DELETE' });
    return new Response(null, { status: 204 });
  }
  if (init.method === 'GET') return new Response(null, { status: 405 });
  const body = JSON.parse(String(init.body));
  mockVendorRequests.push({ auth, method: body.method });
  if (body.method === 'initialize') {
    return json({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'keyvendor', version: '1' },
    } }, { 'mcp-session-id': 'keyvendor-session' });
  }
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method === 'tools/list') {
    return json({ jsonrpc: '2.0', id: body.id, result: { tools: [READ_TOOL, WRITE_TOOL].map((tool) => ({
      name: tool.upstreamName, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations,
    })) } });
  }
  if (body.method === 'tools/call') {
    // Name the account by label, not by echoing the key: the broker redacts a
    // bearer it finds in vendor text, so an echoed key would read [redacted].
    const account = { 'Bearer key-A': 'account-A', 'Bearer key-B': 'account-B' }[auth] || 'unknown-account';
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `jobs of ${account}` }] } });
  }
  return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } });
}

let shipped;
beforeAll(async () => {
  assertHostedMcpEntries([ENTRY]); // the fixture is one the catalogue would load
  shipped = HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ENTRY);
  await setupMongoDb();
});
afterAll(async () => {
  HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...shipped);
  await closeMongoDb();
});

let owner;
let seatA;
let seatB;
let pod;
let previousEnv;

const makeSeat = (agentName) => User.create({
  username: AgentIdentityService.buildAgentUsername(agentName, 'default'),
  email: `${agentName}@agents.commonly.local`,
  password: 'test-password',
  isBot: true,
  botType: 'agent',
  botMetadata: { agentName, instanceId: 'default' },
});

const HOSTED_NATIVE = { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } };

beforeEach(async () => {
  previousEnv = { ...process.env };
  process.env.LITELLM_BASE_URL = 'http://litellm.test';
  process.env.LITELLM_MASTER_KEY = 'test-only';
  delete process.env.HOSTED_TURNS_PER_DAY;
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), RoomGrant.deleteMany({}), AgentRun.deleteMany({}),
    Integration.deleteMany({}), ConnectorSecret.deleteMany({}), AgentInstallation.deleteMany({})]);
  mockLedger.length = 0;
  mockVendorRequests.length = 0;
  owner = await User.create({ username: 'key-owner', email: 'key-owner@example.test', password: 'test-password' });
  seatA = await makeSeat('seat-a');
  seatB = await makeSeat('seat-b');
  pod = await Pod.create({ name: 'Operator key pod', type: 'team', createdBy: owner._id,
    members: [owner._id, seatA._id, seatB._id], publicRead: false, joinPolicy: 'invite-only' });
  // Both seats are installed hosted-native, so the pod passes the broker's
  // outsider-pod eligibility check for real (outsiderGrantPodEligibility.ts).
  await AgentInstallation.create(['seat-a', 'seat-b'].map((agentName) => ({
    agentName, instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id,
    status: 'active', config: HOSTED_NATIVE,
  })));
  axios.post.mockReset();
});
afterEach(() => { process.env = previousEnv; });

/**
 * The row the paste-key route writes (routes/hostedMcpOperatorKey.ts): bound to
 * one agent, its key in the real ConnectorSecret store, then `connected`.
 */
const connectKey = async (seat, key) => {
  const row = await Integration.create({
    type: 'hosted-mcp', scope: 'user', status: 'pending', createdBy: owner._id,
    config: { entryId: ENTRY.id, agentId: String(seat._id), intake: 'operator_key', authGeneration: 1 },
  });
  const credentialRef = await connectorSecrets.put(
    String(row._id), HOSTED_MCP_ACCESS_TOKEN, key, secretWriteGeneration(1, 0),
  );
  await Integration.updateOne({ _id: row._id }, { $set: { status: 'connected', 'config.credentialRef': credentialRef } });
  return row;
};

const grantFor = (seat, row) => RoomGrant.create({
  grantId: `keyvendor-grant-${seat.botMetadata.agentName}`,
  connectionId: String(row._id), installationId: String(row._id),
  target: { kind: 'pod', id: String(pod._id) },
  audience: [String(seat._id)], tools: [READ_NAME], writeMode: 'read',
  expiresAt: new Date(Date.now() + 86400000), brokerId: GRANT_BROKER_ID,
});

const run = (seat) => runAgent({ podId: pod._id, agentName: seat.botMetadata.agentName, instanceId: 'default',
  installedBy: owner._id, displayName: seat.botMetadata.agentName,
  config: HOSTED_NATIVE,
}, { type: 'chat.mention', payload: { content: 'List my jobs.' } });

const finalReply = { data: {
  choices: [{ message: { role: 'assistant', content: 'Done.' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
} };
// The model calls the vendor's read tool when it is offered, then finishes.
const modelCallsReadToolWhenOffered = () => axios.post.mockImplementation(async (_url, body) => {
  const offered = (body.tools || []).map((tool) => tool.function.name);
  const answered = (body.messages || []).some((message) => message.role === 'tool');
  if (offered.includes(READ_FUNCTION) && !answered) {
    return { data: {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'call-1', type: 'function', function: { name: READ_FUNCTION, arguments: '{"limit":5}' },
      }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } };
  }
  return finalReply;
});
/** Function names offered on the run's FIRST model request. */
const offeredOnFirstCall = () => axios.post.mock.calls[0][1].tools.map((tool) => tool.function.name);
/** The tool message the run fed back to the model after its broker call. */
const toolResultSent = () => {
  const last = axios.post.mock.calls[axios.post.mock.calls.length - 1][1];
  return last.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');
};

describe('operator-key hosted MCP is per agent (TASK-330)', () => {
  test('arm 1 per-agent offer: only the bound, granted seat is offered the vendor tool', async () => {
    const rowA = await connectKey(seatA, 'key-A');
    await grantFor(seatA, rowA);
    axios.post.mockResolvedValue(finalReply);

    expect(await run(seatA)).toMatchObject({ status: 'succeeded' });
    expect(offeredOnFirstCall()).toContain(READ_FUNCTION);
    // Reads only on a hosted turn: the write pin is never offered.
    expect(offeredOnFirstCall()).not.toContain('keyvendor_cancel_job');

    axios.post.mockClear();
    expect(await run(seatB)).toMatchObject({ status: 'succeeded' });
    expect(offeredOnFirstCall().filter((name) => name.startsWith('keyvendor'))).toEqual([]);
  });

  test('arm 2 per-agent bearer: each seat reaches the vendor with its own key, never the other', async () => {
    const rowA = await connectKey(seatA, 'key-A');
    const rowB = await connectKey(seatB, 'key-B');
    await grantFor(seatA, rowA);
    await grantFor(seatB, rowB);
    modelCallsReadToolWhenOffered();

    expect(await run(seatA)).toMatchObject({ status: 'succeeded' });
    expect(toolResultSent()).toContain('jobs of account-A');
    const asA = mockVendorRequests.splice(0);

    axios.post.mockClear();
    expect(await run(seatB)).toMatchObject({ status: 'succeeded' });
    expect(toolResultSent()).toContain('jobs of account-B');
    const asB = mockVendorRequests.splice(0);

    for (const [requests, own, other] of [[asA, 'Bearer key-A', 'Bearer key-B'], [asB, 'Bearer key-B', 'Bearer key-A']]) {
      expect(requests.map((request) => request.method)).toEqual(expect.arrayContaining(['initialize', 'tools/call']));
      expect(requests.filter((request) => request.method === 'tools/call')).toHaveLength(1);
      expect(requests.every((request) => request.auth === own)).toBe(true);
      expect(requests.some((request) => request.auth === other)).toBe(false);
    }
  });

  test('arm 3 leave empties the audience: after the bound seat leaves, its run offers no vendor tool', async () => {
    const rowA = await connectKey(seatA, 'key-A');
    await grantFor(seatA, rowA);
    axios.post.mockResolvedValue(finalReply);

    expect(await run(seatA)).toMatchObject({ status: 'succeeded' });
    expect(offeredOnFirstCall()).toContain(READ_FUNCTION); // the positive control for this arm

    await AgentIdentityService.removeAgentFromPod('seat-a', pod._id, 'default');
    const after = await Pod.findById(pod._id).select('members').lean();
    expect(after.members.map(String)).not.toContain(String(seatA._id));

    axios.post.mockClear();
    mockVendorRequests.length = 0;
    expect(await run(seatA)).toMatchObject({ status: 'succeeded' });
    expect(offeredOnFirstCall().filter((name) => name.startsWith('keyvendor'))).toEqual([]);
    expect(mockVendorRequests).toEqual([]);
  });

  // The mint refuses this grant (grants.ts, operatorKeyAudienceRefusal), so it
  // is written straight to the store: a grant from any other path, or one that
  // predates the mint rule, must still never spend A's key on B's turn.
  test('arm 4 call-time binding: a grant on A\'s row that names B is refused, and A\'s key never leaves', async () => {
    const rowA = await connectKey(seatA, 'key-A');
    await RoomGrant.create({
      grantId: 'keyvendor-grant-stray', connectionId: String(rowA._id), installationId: String(rowA._id),
      target: { kind: 'pod', id: String(pod._id) },
      audience: [String(seatB._id)], tools: [READ_NAME], writeMode: 'read',
      expiresAt: new Date(Date.now() + 86400000), brokerId: GRANT_BROKER_ID,
    });
    modelCallsReadToolWhenOffered();

    expect(await run(seatB)).toMatchObject({ status: 'succeeded' });
    expect(toolResultSent()).not.toContain('account-A');
    expect(toolResultSent()).toContain('connection_mismatch');
    expect(mockVendorRequests.some((request) => request.auth === 'Bearer key-A')).toBe(false);
  });
});
