/**
 * TASK-146: `tools/list` over the stateless MCP grant endpoint (TASK-146).
 *
 * Unlike `mcpGrants.test.js`, which mocks the broker to test the transport,
 * this suite uses the REAL broker and the REAL grant checks — only the models
 * and the provider are mocked — so the witnesses below measure the contract
 * that matters: what the list answers is what a call would allow. Each one
 * reddens when the line it protects is reverted.
 */
const express = require('express');
const request = require('supertest');

const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockGithub = { listOpenIssues: jest.fn(), createIssue: jest.fn() };

jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: mockToolCall,
  // eslint-disable-next-line global-require
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../services/githubAppService', () => mockGithub);
jest.mock('../../../services/approvalActionService', () => ({
  proposeAction: jest.fn().mockResolvedValue({ ok: true, approvalId: 'approval-test' }),
}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentRoom: jest.fn() }));
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = {
    _id: 'agent-a',
    username: 'openclaw-aria',
    botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
  };
  req.agentInstallation = { agentName: 'openclaw', instanceId: 'aria' };
  next();
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const router = require('../../../routes/mcpGrants');

const ROW_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');

const seatGrant = (overrides = {}) => ({
  grantId: 'grant-1',
  connectionId: 'connection-1',
  installationId: 'gh-install-1',
  target: { kind: 'seat', id: 'agent-a' },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: ['agent-a'],
  expiresAt: new Date(Date.now() + 60000),
  createdAt: GRANT_CREATED_AT,
  ...overrides,
});

const listTools = async (grantId = 'grant-1') => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp/grants', router);
  return request(app)
    .post(`/api/mcp/grants/${grantId}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
};

const callToolOverHttp = async (name) => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp/grants', router);
  return request(app)
    .post('/api/mcp/grants/grant-1')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} },
    });
};

// The registered catalogue is the real one; hardcoding it here would let the
// parity witness drift from the registry it is checking.
const podTargetGrant = (overrides = {}) => seatGrant({
  target: { kind: 'pod', id: 'pod-1' },
  ...overrides,
});

// The pod lookup refuses when the target is gone, so its position in the
// sequence is observable.
const mockMissingPod = () => {
  mockPod.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(null) }),
  });
};

// eslint-disable-next-line import/no-unresolved, import/extensions
const { getToolDefinitions } = require('../../../services/toolBrokerService');

beforeEach(() => {
  jest.clearAllMocks();
  mockRoomGrant.findOne.mockResolvedValue(seatGrant());
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app',
    status: 'connected',
    createdBy: 'owner-1',
    createdAt: ROW_CREATED_AT,
    config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockGithub.listOpenIssues.mockResolvedValue([]);
});

describe('MCP tools/list is scoped to the grant in the URL', () => {
  it('lists exactly the tools the grant names, by raw name', async () => {
    const listed = await listTools();
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('github.list_issues');
    // The other seven definitions are registered server-side and must not leak.
    expect(listed.text).not.toContain('github.create_issue');
    expect(listed.text).not.toContain('github.merge_pull_request');
    expect(listed.text).not.toContain('github.comment_issue');
  });

  it('refuses an unknown grant id instead of answering with a catalogue', async () => {
    mockRoomGrant.findOne.mockResolvedValue(null);
    const listed = await listTools('000000000000000000000000');
    expect(listed.text).toContain('grant_not_found');
    expect(listed.text).not.toContain('github.list_issues');
    expect(listed.text).not.toContain('inputSchema');
  });

  it('refuses a revoked grant', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ revokedAt: new Date() }));
    const listed = await listTools();
    expect(listed.text).toContain('grant_revoked');
    expect(listed.text).not.toContain('github.list_issues');
  });

  it('refuses a grant whose audience does not include the caller', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({ audience: ['someone-else'] }));
    const listed = await listTools();
    expect(listed.text).toContain('not_in_audience');
    expect(listed.text).not.toContain('github.list_issues');
  });

  it('does not offer a tool the grant\u2019s write mode would refuse', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.create_issue'],
      writeMode: 'read',
    }));
    const listed = await listTools();
    expect(listed.text).not.toContain('github.create_issue');

    // Positive control: the same tool IS listed once the grant allows the mode,
    // so the assertion above is measuring the mode rule, not an empty response.
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.create_issue'],
      writeMode: 'write',
    }));
    const allowed = await listTools();
    expect(allowed.text).toContain('github.create_issue');
  });

  it('refuses a grant that predates its connection row, with the code a call gives', async () => {
    mockIntegration.findOne.mockResolvedValue({
      type: 'github-app',
      status: 'connected',
      createdBy: 'owner-2',
      createdAt: new Date(GRANT_CREATED_AT.getTime() + 60000),
      config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
    });
    const listed = await listTools();
    expect(listed.text).toContain('connection_superseded');
    expect(listed.text).not.toContain('github.list_issues');
  });

  // The claim the whole change rests on: the list promise and the call refusal
  // are the same rule. Measured against every registered tool rather than
  // asserted, so a second definition of the rule shows up here.
  it('agrees with tools/call on every registered tool', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant({
      tools: ['github.list_issues', 'github.create_issue', 'github.merge_pull_request'],
      writeMode: 'read',
    }));
    const listed = await listTools();
    const listedNames = getToolDefinitions()
      .map((definition) => definition.name)
      .filter((name) => listed.text.includes(`"name":"${name}"`));
    expect(listedNames.length).toBeGreaterThan(0);

    const outcomes = await Promise.all(getToolDefinitions().map(async (definition) => {
      const called = await callToolOverHttp(definition.name);
      return {
        name: definition.name,
        listed: listedNames.includes(definition.name),
        refusedByGrantRule: called.text.includes('tool_not_allowed')
          || called.text.includes('write_mode_not_allowed'),
      };
    }));
    outcomes.forEach((outcome) => {
      expect({ name: outcome.name, listed: outcome.listed })
        .toEqual({ name: outcome.name, listed: !outcome.refusedByGrantRule });
    });
  });
});

// Vera 74534: sharing the load preamble with `callTool` moved the pod lookup
// ahead of the `tool_not_found` check, changing the refusal code (and the
// permanent `reason` on the trail row) for a bogus tool name against a grant
// whose target no longer resolves. The order is a behaviour, so it is pinned.
describe('callTool keeps its own check order', () => {
  it('answers a bogus tool name before it resolves the target', async () => {
    mockRoomGrant.findOne.mockResolvedValue(podTargetGrant());
    mockMissingPod();
    const called = await callToolOverHttp('github.not_a_tool');
    expect(called.text).toContain('tool_not_found');
    expect(called.text).not.toContain('target_not_found');
    expect(mockPod.findById).not.toHaveBeenCalled();
    // The refusal is what the trail remembers, so the code has to be right.
    const recorded = mockToolCall.create.mock.calls.map(([row]) => row.reason);
    expect(recorded).toContain('tool_not_found');
    expect(recorded).not.toContain('target_not_found');
  });

  it('resolves the target for a registered tool, so the case above is ordered', async () => {
    mockRoomGrant.findOne.mockResolvedValue(podTargetGrant());
    mockMissingPod();
    const called = await callToolOverHttp('github.list_issues');
    expect(called.text).toContain('target_not_found');
  });
});
