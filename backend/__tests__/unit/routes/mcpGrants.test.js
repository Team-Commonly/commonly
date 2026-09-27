const express = require('express');
const request = require('supertest');

const mockCallTool = jest.fn();
const mockListToolsForGrant = jest.fn();
const mockDefinitions = [{
  name: 'github.list_issues',
  description: 'List issues',
  inputSchema: { type: 'object', properties: {} },
}];

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = {
    _id: 'agent-a',
    username: 'openclaw-aria',
    botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
  };
  req.agentInstallation = { agentName: 'openclaw', instanceId: 'aria' };
  next();
});
jest.mock('../../../services/toolBrokerService', () => ({
  getToolDefinitions: () => mockDefinitions,
  listToolsForGrant: mockListToolsForGrant,
  callTool: mockCallTool,
}));

// eslint-disable-next-line import/no-unresolved, import/extensions
const router = require('../../../routes/mcpGrants');

describe('MCP grant transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListToolsForGrant.mockResolvedValue(mockDefinitions);
  });

  it('projects server tools and calls the broker with token identity', async () => {
    mockCallTool.mockResolvedValue({ callId: 'call-1', result: { issues: [] } });
    const app = express();
    app.use(express.json());
    app.use('/api/mcp/grants', router);

    const initialize = await request(app)
      .post('/api/mcp/grants/grant-1')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });
    expect(initialize.status).toBe(200);
    expect(initialize.text).toContain('commonly-grant-broker');

    const listed = await request(app)
      .post('/api/mcp/grants/grant-1')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('github.list_issues');
    // The URL's grant decides the list; the token identity is the caller
    // (TASK-146). Passing the whole catalogue here was the disclosure.
    expect(mockListToolsForGrant).toHaveBeenCalledWith({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
    });

    const called = await request(app)
      .post('/api/mcp/grants/grant-1')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'github.list_issues', arguments: {} },
      });
    expect(called.status).toBe(200);
    expect(called.text).toContain('issues');
    expect(mockCallTool).toHaveBeenCalledWith({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      agentName: 'openclaw',
      instanceId: 'aria',
      tool: 'github.list_issues',
      args: {},
    });
  });

  it('answers a refused grant with the same code a call gives, not a catalogue', async () => {
    const refusal = new Error('grant is revoked');
    refusal.code = 'grant_revoked';
    mockListToolsForGrant.mockRejectedValue(refusal);
    const app = express();
    app.use(express.json());
    app.use('/api/mcp/grants', router);

    const listed = await request(app)
      .post('/api/mcp/grants/grant-1')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });

    // An empty list would read as "this grant has no tools"; the refusal has to
    // be visible as a refusal.
    expect(listed.text).toContain('grant_revoked');
    expect(listed.text).not.toContain('github.list_issues');
  });
});
