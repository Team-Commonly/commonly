/**
 * TASK-330 paste-key intake route. The row, the agent check, the secret store
 * and the vendor probe are mocked at their module edges; the handler, the
 * scope refusal and the intake probe are real. The key must never come back in
 * a response or reach the row, and the scope the route reports must be a
 * self-report whatever the body claims (Vera's review of 2d4e37fc7).
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../../models/Integration', () => ({ findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ put: jest.fn() }));
jest.mock('../../../services/hostedMcpToolDefinitions', () => ({
  guardedFetch: jest.fn(),
  listHostedMcpTools: jest.fn(),
}));

const Integration = require('../../../models/Integration');
const User = require('../../../models/User');
const connectorSecrets = require('../../../services/connectorSecrets');
const { listHostedMcpTools } = require('../../../services/hostedMcpToolDefinitions');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { submitOperatorKey } = require('../../../routes/hostedMcpOperatorKey');

const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const AGENT = 'cccccccccccccccccccccc01';
const ROW_ID = 'eeeeeeeeeeeeeeeeeeeeee02';
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
app.post('/connect/hosted-mcp/:entryId/operator-key', (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
  return next();
}, submitOperatorKey);

const submit = (body = {}) => request(app)
  .post('/connect/hosted-mcp/latchkey/operator-key')
  .set('x-test-user', OWNER)
  .send({ agentId: AGENT, key: KEY, ...body });

let shipped;
beforeEach(() => {
  jest.clearAllMocks();
  shipped = HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, KEY_ENTRY);
  User.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: AGENT }) }) });
  listHostedMcpTools.mockResolvedValue([{ name: 'list_jobs' }]);
  Integration.findOneAndUpdate.mockResolvedValue({ _id: ROW_ID, config: { authGeneration: 1 } });
  Integration.updateOne.mockResolvedValue({ acknowledged: true });
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

  test('a valid key writes a pending row, stores the secret on it, then connects it', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      integrationId: ROW_ID, status: 'connected', scopeCheck: 'self_report', toolCount: 1, 
    });
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      {
        type: 'hosted-mcp', createdBy: OWNER, 'config.entryId': 'latchkey', 'config.agentId': AGENT, 
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'pending' }) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(connectorSecrets.put).toHaveBeenCalledWith(ROW_ID, expect.anything(), KEY, expect.any(Number));
    expect(Integration.updateOne).toHaveBeenCalledWith(
      { _id: ROW_ID },
      { $set: { status: 'connected', 'config.credentialRef': 'secret-ref-1' } },
    );
  });

  test('scopeCheck is a self-report even when the body claims a readback', async () => {
    const res = await submit({ scopeCheck: 'read', reportedScopes: ['read'] });
    expect(res.status).toBe(201);
    expect(res.body.scopeCheck).toBe('self_report');
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
