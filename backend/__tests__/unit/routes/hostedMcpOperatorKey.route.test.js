/**
 * TASK-330 paste-key intake route. The row, the secret store, the vendor probe
 * and the installation data are mocked at their module edges; the handler, the
 * scope refusal, the intake probe and the sole-installer rule
 * (services/runtimeIdentityOwnership.ts) are real. The key must never come back
 * in a response or reach the row, and the scope the route reports must be a
 * self-report whatever the body claims (Vera's review of 2d4e37fc7).
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../../models/Integration', () => ({ findOneAndUpdate: jest.fn(), updateOne: jest.fn(), exists: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ put: jest.fn(), revoke: jest.fn(), revokeOwnWrite: jest.fn() }));
jest.mock('../../../services/roomGrantService', () => ({ revokeConnectionGrants: jest.fn() }));
jest.mock('../../../services/hostedMcpToolDefinitions', () => ({
  guardedFetch: jest.fn(),
  listHostedMcpTools: jest.fn(),
  forgetHostedMcpDrift: jest.fn(),
}));
// The route is reached through the production router, and auth and the write
// limiter are observable, so dropping either from the registration fails a test.
jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
  return next();
}));
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: jest.fn((_req, _res, next) => next()),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

const Integration = require('../../../models/Integration');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const connectorSecrets = require('../../../services/connectorSecrets');
const { listHostedMcpTools, forgetHostedMcpDrift } = require('../../../services/hostedMcpToolDefinitions');
const { revokeConnectionGrants } = require('../../../services/roomGrantService');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const auth = require('../../../middleware/auth');
const { writeIntegrationsRateLimit } = require('../../../middleware/integrationRateLimit');
const connectRoutes = require('../../../routes/hostedMcpConnect');

const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbb02';
const AGENT = 'cccccccccccccccccccccc01';
const ROW_ID = 'eeeeeeeeeeeeeeeeeeeeee02';
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa03';
const DM_POD = 'aaaaaaaaaaaaaaaaaaaaaa02';
const KEY = 'lk_live_SECRET_VALUE_DO_NOT_ECHO';

const KEY_ENTRY = {
  id: 'latchkey',
  title: 'Latchkey',
  resource: 'https://latchkey.example/mcp',
  credentialMode: 'operator_key',
  scopes: [],
  revoke: 'https://latchkey.example/keys',
  tools: [{
    name: 'list_jobs',
    upstreamName: 'list_jobs',
    description: 'List jobs',
    class: 'read',
    inputSchema: { type: 'object' },
  }],
};

const app = express();
app.use(express.json());
app.use('/connect/hosted-mcp', connectRoutes);

const submit = (body = {}) => request(app)
  .post('/connect/hosted-mcp/latchkey/operator-key')
  .set('x-test-user', OWNER)
  .send({ agentId: AGENT, key: KEY, ...body });

// The installations of the agent identity, and which of their pods are agent-dm.
let installations;
let dmPods;

let shipped;
beforeEach(() => {
  jest.clearAllMocks();
  shipped = HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, KEY_ENTRY);
  User.findOne.mockReturnValue({
    select: () => ({ lean: async () => ({ _id: AGENT, botMetadata: { agentName: 'OpenClaw', instanceId: 'latch' } }) }),
  });
  installations = [{ installedBy: OWNER, podId: POD }];
  dmPods = [];
  AgentInstallation.find.mockImplementation(() => ({
    collation: () => ({ select: () => ({ lean: async () => installations }) }),
  }));
  Pod.find.mockImplementation(() => ({ select: () => ({ lean: async () => dmPods }) }));
  listHostedMcpTools.mockResolvedValue([{ name: 'list_jobs' }]);
  Integration.findOneAndUpdate.mockResolvedValue({ _id: ROW_ID, config: { authGeneration: 1 } });
  Integration.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  connectorSecrets.put.mockResolvedValue('secret-ref-1');
});
afterEach(() => {
  HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...shipped);
});

/** Every value the route handed to a model write, so a leak anywhere shows. */
const everyWrittenValue = () => JSON.stringify([
  Integration.findOneAndUpdate.mock.calls,
  Integration.updateOne.mock.calls,
]);

describe('POST /connect/hosted-mcp/:entryId/operator-key', () => {
  test('the write limiter runs, then auth, and a caller with no session stops there', async () => {
    const res = await request(app)
      .post('/connect/hosted-mcp/latchkey/operator-key')
      .send({ agentId: AGENT, key: KEY });

    expect(res.status).toBe(401);
    expect(writeIntegrationsRateLimit).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(writeIntegrationsRateLimit.mock.invocationCallOrder[0]).toBeLessThan(auth.mock.invocationCallOrder[0]);
    expect(User.findOne).not.toHaveBeenCalled();
    expect(listHostedMcpTools).not.toHaveBeenCalled();
    expect(connectorSecrets.put).not.toHaveBeenCalled();
  });

  test('a refused scope among the operator picks is refused before any vendor call or row write', async () => {
    const res = await submit({ scopePicks: ['read', 'jobs:approve'] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'scope_refused' });
    expect(res.body.message).toMatch(/jobs:approve/);
    expect(listHostedMcpTools).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(connectorSecrets.put).not.toHaveBeenCalled();
  });

  test('a vendor that rejects the key is refused, and no row or secret is written', async () => {
    listHostedMcpTools.mockRejectedValue(Object.assign(new Error('nope'), { code: 'credential_rejected' }));
    const res = await submit();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'vendor_rejected', message: 'the vendor rejected this key' });
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(connectorSecrets.put).not.toHaveBeenCalled();
  });

  test('an agentId that is not a bot is refused before the probe', async () => {
    User.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    const res = await submit();
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_agent' });
    expect(listHostedMcpTools).not.toHaveBeenCalled();
  });

  test('a bot with no agent identity is refused before the probe', async () => {
    User.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: AGENT, botMetadata: {} }) }) });
    const res = await submit();
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_agent' });
    expect(AgentInstallation.find).not.toHaveBeenCalled();
    expect(listHostedMcpTools).not.toHaveBeenCalled();
  });

  test('the sole owner of the agent passes, and the identity is read from the bot row, lowercased', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      integrationId: ROW_ID, status: 'connected', scopeCheck: 'self_report', toolCount: 1,
    });
    expect(AgentInstallation.find).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'openclaw', instanceId: 'latch' }));
  });

  test('a caller with no installation of the agent is refused 403 before any probe or write', async () => {
    installations = [];
    const res = await submit();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'agent_not_owned',
      failure: 'owner_installation_missing',
      message: 'you must be the sole installer of this agent',
    });
    expect(listHostedMcpTools).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(connectorSecrets.put).not.toHaveBeenCalled();
  });

  test('an agent with a second installer is refused 403, even when the caller also installed it', async () => {
    installations = [
      { installedBy: OWNER, podId: POD },
      { installedBy: OTHER, podId: OTHER_POD },
    ];
    const res = await submit();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'agent_not_owned', failure: 'another_installer' });
    expect(listHostedMcpTools).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('an agent-dm installation is a conversation, not ownership: the caller is refused', async () => {
    installations = [{ installedBy: OWNER, podId: DM_POD }];
    dmPods = [{ _id: DM_POD }];
    const res = await submit();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'agent_not_owned', failure: 'owner_installation_missing' });
    expect(listHostedMcpTools).not.toHaveBeenCalled();
  });

  test('scopeCheck is a self-report even when the body claims a readback', async () => {
    const res = await submit({ scopeCheck: 'read', reportedScopes: ['read'] });
    expect(res.status).toBe(201);
    expect(res.body.scopeCheck).toBe('self_report');
  });

  test('a valid key writes a pending row, stores the secret on it, then connects it', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      {
        type: 'hosted-mcp', createdBy: OWNER, 'config.entryId': 'latchkey', 'config.agentId': AGENT,
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'pending' }) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(connectorSecrets.put).toHaveBeenCalledWith(ROW_ID, expect.anything(), KEY, expect.any(Number));
    expect(Integration.updateOne).toHaveBeenCalledWith(
      {
        _id: ROW_ID, 'config.authGeneration': 1, status: 'pending', revokedAt: null,
      },
      { $set: { status: 'connected', 'config.credentialRef': 'secret-ref-1' } },
    );
    // A first paste has no grants to end.
    expect(revokeConnectionGrants).not.toHaveBeenCalled();
  });

  // Both F07 reviewers: fetch strips header whitespace, so a key pasted with a
  // newline authenticates while the stored copy no longer matches what the
  // vendor echoes, and redaction (an exact match) lets it through.
  test('a key pasted with surrounding whitespace is stored as the trimmed value the probe proved', async () => {
    const res = await submit({ key: `  ${KEY}\n` });
    expect(res.status).toBe(201);
    expect(listHostedMcpTools).toHaveBeenCalledWith(expect.anything(), KEY, expect.anything());
    expect(connectorSecrets.put).toHaveBeenCalledWith(ROW_ID, expect.anything(), KEY, expect.any(Number));
  });

  // A grant was decided against the key that was connected then; a pasted key
  // cannot prove it is the same account, so a re-paste ends them, as the OAuth
  // callback does for a subject it cannot compare (hostedMcpConnect.ts).
  test('a re-paste on an existing row revokes its grants and forgets its drift before storing the new key', async () => {
    const existing = { _id: ROW_ID, config: { authGeneration: 2 } };
    Integration.findOneAndUpdate.mockResolvedValue(existing);
    const res = await submit();
    expect(res.status).toBe(201);
    expect(revokeConnectionGrants).toHaveBeenCalledWith({ connection: existing, revokedBy: OWNER });
    expect(forgetHostedMcpDrift).toHaveBeenCalledWith(ROW_ID);
    expect(revokeConnectionGrants.mock.invocationCallOrder[0])
      .toBeLessThan(connectorSecrets.put.mock.invocationCallOrder[0]);
  });

  test('a paste clears the row\'s revocation, error and provider-revoked mark', async () => {
    await submit();
    const [, update] = Integration.findOneAndUpdate.mock.calls[0];
    expect(update.$set).toEqual(expect.objectContaining({ revokedAt: null, errorMessage: null }));
    expect(update.$unset).toEqual({ 'config.providerRevokedAt': '' });
  });

  // The paste's own write is generation 1 (authGeneration 1, refresh 0).
  const OWN_WRITE = 1_000_000;

  test('a row removed while the key was being saved: the new secret is revoked and the paste refused', async () => {
    Integration.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 0 });
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'connection_changed', message: 'the connection changed while the key was saved; paste it again' });
    expect(connectorSecrets.revokeOwnWrite).toHaveBeenCalledWith('secret-ref-1', OWN_WRITE);
    expect(connectorSecrets.revoke).not.toHaveBeenCalled();
  });

  // Removal marks the row disconnected and revoked before it deletes it
  // (connectionRemovalService), so a paste can finish between the two. That
  // row must not go back to connected, and nothing will use the new secret.
  test('a row marked by a removal mid-paste stays unpublished, and its new secret is revoked', async () => {
    const marked = {
      _id: ROW_ID, 'config.authGeneration': 1, status: 'disconnected', revokedAt: new Date(),
    };
    const matches = (filter) => Object.entries(filter)
      .every(([key, value]) => (value === null ? marked[key] == null : marked[key] === value));
    Integration.updateOne.mockImplementation(async (filter) => ({
      acknowledged: true, matchedCount: matches(filter) ? 1 : 0,
    }));
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('connection_changed');
    expect(connectorSecrets.revokeOwnWrite).toHaveBeenCalledWith('secret-ref-1', OWN_WRITE);
  });

  // The ref is reused, so a newer paste may own it by now. The delete is fenced
  // on this paste's own write generation, which a newer write has replaced
  // (the store's own test pins that), never a delete by ref alone.
  test('a newer paste that won the row keeps its secret: the older paste deletes only its own write', async () => {
    Integration.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 0 });
    const res = await submit();
    expect(res.status).toBe(409);
    expect(connectorSecrets.revoke).not.toHaveBeenCalled();
    expect(connectorSecrets.revokeOwnWrite).toHaveBeenCalledWith('secret-ref-1', OWN_WRITE);
  });

  test('the key appears in no response, no row write, and no thrown error text', async () => {
    const ok = await submit();
    expect(JSON.stringify(ok.body)).not.toContain(KEY);
    expect(everyWrittenValue()).not.toContain(KEY);

    listHostedMcpTools.mockRejectedValue(new Error(`upstream echoed ${KEY}`));
    const unreachable = await submit();
    expect(JSON.stringify(unreachable.body)).not.toContain(KEY);
  });

  test('a failed secret write leaves the row pending, never connected, and says so without the key', async () => {
    connectorSecrets.put.mockRejectedValue(new Error(`store failed for ${KEY}`));
    const res = await submit();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'key_store_failed', message: 'the key could not be stored; try again' });
    expect(Integration.updateOne).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });
});
