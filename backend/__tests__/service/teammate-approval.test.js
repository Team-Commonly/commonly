// TASK-512 launch scope: a teammate's agent asks for a write under another
// person's connection, and only the credential owner can approve it.
// ADR-033 B3 reads the decision record from `resolvedBy` with
// `decidedByRole: credential-owner`, so these cases pin the facts it relies on.
process.env.PG_HOST = '';
process.env.JWT_SECRET = 'teammate-approval-test-only';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
jest.mock('../../services/githubAppService', () => ({
  getPullRequest: jest.fn(async () => ({ head: { sha: 'pinned-head' } })),
  mergePullRequest: jest.fn(async () => ({ merged: true, sha: 'merged-head' })),
}));
jest.mock('../../models/ToolCall', () => ({
  create: jest.fn(async () => undefined),
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: jest.fn(async () => true),
}));
jest.mock('../../services/agentMessageService', () => ({
  postMessage: jest.fn(async () => ({ success: true, message: { _id: new (require('mongoose').Types.ObjectId)() } })),
}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn(async () => ({})) }));
jest.mock('../../services/needsYouEmailService', () => ({ sendNeedsYouEmail: jest.fn(async () => undefined) }));
jest.mock('../../config/socket', () => ({ getIO: jest.fn(() => null) }));
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const ApprovalAction = require('../../models/ApprovalAction');
const AttentionItem = require('../../models/AttentionItem');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Installable = require('../../models/Installable');
const { buildGithubToolInstallable } = require('../../services/installable/toolInstallables');
const grants = require('../../services/roomGrantService');
const broker = require('../../services/toolBrokerService');
const approvals = require('../../services/approvalActionService');
const github = require('../../services/githubAppService');
const ToolCall = require('../../models/ToolCall');

const app = express();
app.use(express.json());
app.use('/api/approvals', require('../../routes/approvals'));

// A owns the GitHub connection. B is A's teammate and owns the agent.
let a, b, agent, pod;
const human = (name) => User.create({ username: name, email: `${name}@example.test`, password: 'test-password' });
const bearer = (person) => `Bearer ${jwt.sign({ id: String(person._id), tokenVersion: 0 }, process.env.JWT_SECRET)}`;

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  jest.clearAllMocks();
  await clearMongoDb();
  a = await human('credential-a');
  b = await human('teammate-b');
  agent = await User.create({
    username: 'agent-b', email: 'agent-b@example.test', password: 'test-password', isBot: true, botType: 'agent',
    botMetadata: { agentName: 'agent-b', instanceId: 'default', ownerUserId: String(b._id) },
  });
  pod = await Pod.create({
    name: 'Teammate approval', type: 'team', createdBy: a._id,
    members: [a._id, b._id, agent._id], joinPolicy: 'invite-only', publicRead: false,
  });
  await AgentInstallation.create({
    agentName: 'agent-b', instanceId: 'default', podId: pod._id, installedBy: b._id, version: '1.0.0',
    status: 'active', config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native' } },
  });
  const connection = await Integration.create({
    type: 'github-app', scope: 'user', status: 'connected', createdBy: a._id,
    config: { installationId: 'test-install', owner: 'test-owner', repo: 'test-repo' },
  });
  await Installable.create(buildGithubToolInstallable());
  const grant = await grants.mintGrant({
    connectionId: String(connection._id), installationId: 'test-install', brokerId: 'test-broker',
    target: { kind: 'pod', id: String(pod._id) }, audience: [String(agent._id)],
    tools: ['github.merge_pull_request'], writeMode: 'write-with-confirm',
    expiresAt: new Date(Date.now() + 60000),
  });
  await expect(broker.callTool({
    grantId: grant.grantId, agentUserId: String(agent._id), agentName: 'agent-b', instanceId: 'default',
    hostedTurn: true, tool: 'github.merge_pull_request', args: { pullNumber: 7 },
  })).rejects.toMatchObject({ code: 'approval_required' });
});

const parked = () => ApprovalAction.findOne({ actionType: 'tool_call' });
const httpDecide = (row, person, decision = 'approved') => request(app)
  .post(`/api/approvals/${row._id}/resolve`)
  .set('Authorization', bearer(person))
  // Identity fields in the body must not choose who decided.
  .send({ decision, resolvedBy: String(b._id), decidedBy: String(b._id), callerUserId: String(b._id) });

test('the teammate agent\'s write asks only the credential owner, never the agent owner', async () => {
  const row = await parked();
  expect(String(row.ownerUserId)).toBe(String(a._id));
  // B3 records the decider as credential-owner; that holds only while the
  // asked human and the connection owner are the same person.
  expect(row.toolCall.credentialOwnerId).toBe(String(a._id));
  const queue = await AttentionItem.find({
    'source.type': 'approval_action', 'source.id': String(row._id), status: 'open',
  }).lean();
  expect(queue.map((item) => String(item.recipientUserId))).toEqual([String(a._id)]);

  expect((await httpDecide(row, b)).status).toBe(403);
  const asAgent = await approvals.resolveApproval({
    approvalId: String(row._id), callerUserId: String(agent._id), decision: 'approved',
  });
  expect(asAgent.status).toBe(403);
  const pending = await ApprovalAction.findById(row._id);
  expect(pending.status).toBe('flagged');
  expect(pending.resolvedBy).toBeUndefined();
  expect(github.mergePullRequest).not.toHaveBeenCalled();
});

test('the credential owner approves the pinned merge once, and the row names them as the decider', async () => {
  const row = await parked();
  const result = await httpDecide(row, a);
  expect(result.status).toBe(200);
  expect(result.body.approval).toMatchObject({ decision: 'approved', toolCallEnding: 'ran' });
  expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
  expect(github.mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ sha: 'pinned-head', pullNumber: 7 }));

  const saved = await ApprovalAction.findById(row._id);
  expect(String(saved.resolvedBy)).toBe(String(a._id));
  expect(saved.toolCall.credentialOwnerId).toBe(String(a._id));
  expect(saved.toolCall.canonicalArgs).toBeUndefined();
  expect(ToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', credentialOwnerId: String(a._id) }));
  expect(await AttentionItem.countDocuments({ 'source.id': String(row._id), status: 'open' })).toBe(0);

  expect((await httpDecide(row, a)).status).toBe(409);
  expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
});

test('the credential owner declining records them without a provider call', async () => {
  const row = await parked();
  const result = await httpDecide(row, a, 'declined');
  expect(result.status).toBe(200);
  expect(result.body.approval).toMatchObject({ decision: 'declined', toolCallEnding: 'declined' });
  const saved = await ApprovalAction.findById(row._id);
  expect(String(saved.resolvedBy)).toBe(String(a._id));
  expect(saved.toolCall.canonicalArgs).toBeUndefined();
  expect(await AttentionItem.countDocuments({ 'source.id': String(row._id), status: 'open' })).toBe(0);
  expect(github.mergePullRequest).not.toHaveBeenCalled();
});
