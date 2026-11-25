// F626: the grant broker answers a driver or transport failure with fixed text.
// An error carrying a statusCode (a RoomGrantError) still says its own message.
const express = require('express');
const request = require('supertest');

const mockCallTool = jest.fn();
const mockListToolsForGrant = jest.fn();
const mockReserveBudgetLineage = jest.fn();
const mockHandleRequest = jest.fn();
const AGENT_ID = '507f1f77bcf86cd799439011';
const DRIVER_TEXT = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { _id: AGENT_ID, username: 'kai', botMetadata: { agentName: 'kai', instanceId: 'default' } };
  req.agentInstallation = { agentName: 'kai', instanceId: 'default' };
  req.agentTokenHash = 'a'.repeat(64);
  next();
});
jest.mock('../../../services/toolBrokerService', () => ({
  listToolsForGrant: mockListToolsForGrant,
  callTool: mockCallTool,
}));
jest.mock('../../../models/ToolCall', () => ({ reserveBudgetLineage: mockReserveBudgetLineage }));
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn(() => ({ handleRequest: (...a) => mockHandleRequest(...a) })),
}));
jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn(() => ({ setRequestHandler: jest.fn(), connect: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) })),
}));

const router = require('../../../routes/mcpGrants');

const app = express();
app.use('/api/mcp/grants/:grantId/push', express.json({ limit: '9mb' }));
app.use(express.json());
app.use('/api/mcp/grants', router);

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const expectFixed = (res, status, body) => {
  expect(res.status).toBe(status);
  expect(res.body).toEqual(body);
  expect(res.text).not.toContain('db.internal.example');
  expect(res.text).not.toContain('secret_table');
  const logs = JSON.stringify(errorSpy.mock.calls);
  expect(logs).toContain('db.internal.example');
};

describe('mcp grants 500s', () => {
  it('push: a driver error answers fixed text and logs the cause', async () => {
    mockListToolsForGrant.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post('/api/mcp/grants/g1/push')
      .send({ ref: 'refs/heads/x', baseOid: 'a', newOid: 'b', bundle: 'c' });
    expectFixed(res, 500, { error: 'broker_error', message: 'Tool call failed' });
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('MCP grant call failed:');
  });

  it('cli: a driver error from the budget reservation answers fixed text', async () => {
    mockListToolsForGrant.mockResolvedValue([{ name: 'github.get_pull_request' }]);
    mockReserveBudgetLineage.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post('/api/mcp/grants/g1/cli')
      .send({ operation: 'pr.view', args: { pullNumber: 12 } });
    expectFixed(res, 500, { error: 'broker_error', message: 'Tool call failed' });
  });

  it('cli: an error with its own statusCode keeps its status and message', async () => {
    mockListToolsForGrant.mockRejectedValue(Object.assign(new Error('Grant revoked'), { statusCode: 403, code: 'grant_revoked' }));
    const res = await request(app).post('/api/mcp/grants/g1/cli')
      .send({ operation: 'pr.view', args: { pullNumber: 12 } });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Grant revoked');
  });

  it('transport: a failure answers fixed text, keeps the code and logs the cause', async () => {
    mockHandleRequest.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post('/api/mcp/grants/g1').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expectFixed(res, 500, { error: 'broker_transport_error', message: 'Tool call failed' });
  });
});
