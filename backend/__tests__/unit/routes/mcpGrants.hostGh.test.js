const express = require('express');
const request = require('supertest');
const { readFileSync } = require('fs');
const { join } = require('path');

const mockCallTool = jest.fn();
const mockListToolsForGrant = jest.fn();
const mockReserveBudgetLineage = jest.fn();
const AGENT_ID = '507f1f77bcf86cd799439011';

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

// eslint-disable-next-line import/no-unresolved, import/extensions
const router = require('../../../routes/mcpGrants');

const app = express();
app.use('/api/mcp/grants/:grantId/push', express.json({ limit: '9mb' }));
app.use(express.json());
app.use('/api/mcp/grants', router);

const operations = [
  ['pr.create', 'github.create_pull_request', { title: 'Work', head: `seat/${AGENT_ID}/work`, base: 'main' }],
  ['pr.view', 'github.get_pull_request', { pullNumber: 12 }],
  ['pr.comment', 'github.comment_on_pull_request', { pullNumber: 12, body: 'A comment' }],
  ['pr.review_comment', 'github.review_pull_request_comment', { pullNumber: 12, body: 'A review' }],
  ['issue.comment', 'github.comment_on_issue', { issueNumber: 12, body: 'A comment' }],
];
const refusedOperations = ['pr.merge', 'pr.close', 'issue.close', 'api', 'branch.delete', 'pr.review_approve'];

beforeEach(() => {
  jest.clearAllMocks();
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockListToolsForGrant.mockResolvedValue(operations.map(([, name]) => ({ name })));
  mockCallTool.mockResolvedValue({ callId: 'call-1', outcome: 'ok', result: { number: 12 } });
});

describe('host GitHub broker command boundary', () => {
  it.each(operations)('maps %s to its fixed broker tool', async (operation, tool, args) => {
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({ operation, args });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ callId: 'call-1', outcome: 'ok' });
    expect(mockCallTool).toHaveBeenCalledWith({
      grantId: 'grant-1', agentUserId: AGENT_ID, agentName: 'kai', instanceId: 'default', tool, args,
    });
    expect(mockReserveBudgetLineage).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ calls: operation === 'pr.view' ? 30 : 10, windowMs: 60000 }),
    ]));
  });

  it.each(refusedOperations)('refuses %s before grant disclosure or provider call', async (operation) => {
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({ operation, args: {} });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('operation_not_allowed');
    expect(mockListToolsForGrant).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('refuses a PR head outside the authenticated seat prefix', async () => {
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({
      operation: 'pr.create', args: { title: 'Work', head: 'other/work', base: 'main' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('branch_not_owned_by_seat');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it.each([
    `seat/${AGENT_ID}/../other`,
    `seat/${AGENT_ID}//other`,
    `seat/${AGENT_ID}/topic.lock`,
    `seat/${AGENT_ID}/topic.`,
    `seat/${AGENT_ID}/topic?x`,
  ])('refuses malformed seat branch %s before provider call', async (head) => {
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({
      operation: 'pr.create', args: { title: 'Work', head, base: 'main' },
    });
    expect(response.status).toBe(403);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('refuses an operation missing from this seat grant before budget use', async () => {
    mockListToolsForGrant.mockResolvedValue([{ name: 'github.get_pull_request' }]);
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({
      operation: 'issue.comment', args: { issueNumber: 12, body: 'Comment' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('operation_not_granted');
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('refuses an exhausted token or grant budget', async () => {
    mockReserveBudgetLineage.mockResolvedValue(false);
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({
      operation: 'pr.view', args: { pullNumber: 12 },
    });
    expect(response.status).toBe(429);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('returns approval state without executing another operation', async () => {
    mockCallTool.mockRejectedValue(Object.assign(new Error('pending'), {
      code: 'approval_required', details: { approvalId: 'approval-1' },
    }));
    const response = await request(app).post('/api/mcp/grants/grant-1/cli').send({
      operation: 'pr.create', args: { title: 'Work', head: `seat/${AGENT_ID}/work`, base: 'main' },
    });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'pending_approval', approvalId: 'approval-1' });
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });
});

describe('host GitHub push boundary', () => {
  const push = {
    ref: `refs/heads/seat/${AGENT_ID}/work`, baseOid: 'a'.repeat(40),
    newOid: 'b'.repeat(40), bundle: 'YnVuZGxl',
  };

  it('requires the exact push tool and reserves two token/grant slots', async () => {
    mockListToolsForGrant.mockResolvedValue([{ name: 'github.push_branch' }]);
    const response = await request(app).post('/api/mcp/grants/grant-1/push').send(push);
    expect(response.status).toBe(200);
    expect(mockCallTool).toHaveBeenCalledWith(expect.objectContaining({
      grantId: 'grant-1', agentUserId: AGENT_ID, tool: 'github.push_branch', args: push,
    }));
    expect(mockReserveBudgetLineage).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ calls: 2, windowMs: 60000 }),
    ]));
  });

  it('refuses a read-only or omitted push tool before budget use', async () => {
    mockListToolsForGrant.mockResolvedValue([{ name: 'github.get_pull_request' }]);
    const response = await request(app).post('/api/mcp/grants/grant-1/push').send(push);
    expect(response.status).toBe(403);
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('refuses exhausted push budget before any provider call', async () => {
    mockListToolsForGrant.mockResolvedValue([{ name: 'github.push_branch' }]);
    mockReserveBudgetLineage.mockResolvedValue(false);
    const response = await request(app).post('/api/mcp/grants/grant-1/push').send(push);
    expect(response.status).toBe(429);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('preserves the larger push parser before the global JSON parser in the real server', async () => {
    const source = readFileSync(join(__dirname, '../../../server.ts'), 'utf8');
    expect(source.indexOf("app.use('/api/mcp/grants/:grantId/push', mcpGrantsRoutes.pushBodyRateLimit,"))
      .toBeGreaterThan(-1);
    expect(source.indexOf("app.use('/api/mcp/grants/:grantId/push'"))
      .toBeLessThan(source.indexOf('app.use(express.json());'));
    mockListToolsForGrant.mockResolvedValue([{ name: 'github.push_branch' }]);
    const response = await request(app).post('/api/mcp/grants/grant-1/push').send({
      ...push, bundle: 'A'.repeat(200_000),
    });
    expect(response.status).toBe(200);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });
});
