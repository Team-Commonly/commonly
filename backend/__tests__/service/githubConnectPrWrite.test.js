/**
 * F172: a PR write on a Commonly Connect connection keeps every TASK-783 rule.
 * It parks for the connection owner, runs once on the owner's approval, and
 * the GitHub call is signed by the row's App (`connect`), never the tools App.
 * A legacy row with no `app` still runs as tools. Same harness as
 * prWriteApproval.test.js: memory Mongo, real broker/grant/approval services,
 * GitHub mocked at githubAppService.
 *
 * HOLD 1: every Connect write re-proves the owner's access with their current
 * GitHub user token (fake GitHub at hostedVendorFetch; the hosted-MCP
 * credential opener returns the row's stored token). Losing push, the
 * repository changing identity, or removing the GitHub connection refuses
 * `connection_unproven`, at park and again at execute, and nothing is written.
 */
process.env.PG_HOST = '';
process.env.JWT_SECRET = 'github-connect-pr-test-only';
const { createHash } = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const mockTrail = [];
jest.mock('../../models/ToolCall', () => {
  const digestArgs = (args) => require('crypto').createHash('sha256')
    .update(JSON.stringify(args === undefined ? {} : args)).digest('hex');
  // The broker imports the default; the approval service requires the module.
  const create = jest.fn(async (row) => { mockTrail.push(row); return row; });
  return {
    __esModule: true,
    default: { create, digestArgs },
    create,
    digestArgs,
    reserveBudgetLineage: jest.fn(async () => true),
  };
});
jest.mock('../../services/githubAppService', () => ({
  createPullRequest: jest.fn(async () => ({ number: 101, html_url: 'https://github.com/o/r/pull/101' })),
  getBranchHead: jest.fn(async ({ branch }) => (branch === 'main' ? '1'.repeat(40) : null)),
  getCommitTree: jest.fn(),
  createTextTree: jest.fn(),
  createCommit: jest.fn(),
  createBranchRef: jest.fn(),
  fastForwardBranchRef: jest.fn(),
  getInstallationToken: jest.fn(),
  getDefaultBranch: jest.fn(async () => 'main'),
  getTreeEntries: jest.fn(async () => ({ entries: [], truncated: false })),
  getIssue: jest.fn(async () => ({ number: 12, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/12' })),
  listOpenIssues: jest.fn(async () => []),
  getPullRequest: jest.fn(async () => ({ number: 5, title: 'PR', state: 'open', html_url: 'https://github.com/o/r/pull/5' })),
  listPullRequestFiles: jest.fn(async () => []),
  closeIssue: jest.fn(async () => ({ number: 12, state: 'closed', html_url: 'https://github.com/o/r/issues/12' })),
  createIssue: jest.fn(async () => ({ number: 13, html_url: 'https://github.com/o/r/issues/13' })),
  addIssueComment: jest.fn(async () => ({ id: 1, html_url: 'https://github.com/o/r/issues/12#c1' })),
}));
// A seat's own sandbox, as the server judges it. Hosted turns never ask.
const mockJudge = jest.fn();
jest.mock('../../services/seatGrantConfinement', () => ({
  ...jest.requireActual('../../services/seatGrantConfinement'),
  judgeSeatConfinement: (...args) => mockJudge(...args),
}));
jest.mock('../../services/agentMessageService', () => ({
  postMessage: jest.fn(async () => ({ success: true, message: { _id: new (require('mongoose').Types.ObjectId)().toString() } })),
}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn(async () => ({})) }));
jest.mock('../../services/attentionItemService', () => ({
  recordActionApproval: jest.fn(async () => undefined),
  resolve: jest.fn(async () => undefined),
  resolveExpired: jest.fn(async () => undefined),
}));
// Every room emit, so a test can prove what a socket carried.
const mockEmits = [];
jest.mock('../../config/socket', () => ({
  getIO: jest.fn(() => ({ to: (room) => ({ emit: (event, payload) => mockEmits.push({ room, event, payload }) }) })),
}));
jest.mock('../../models/Message', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../../services/brokerRecordService', () => ({
  recordBrokerCall: jest.fn(),
  recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(),
  recordGrantsRevoked: jest.fn(),
  recordGrantIssued: jest.fn(),
}));
// The pod gate has its own suites; here the pod is eligible.
jest.mock('../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => reason),
}));
// The owner's view of GitHub through their user token.
const mockView = { push: true, repositoryId: 555, listed: true, suspended: false, calls: 0 };
jest.mock('../../services/hostedVendorFetch', () => ({
  hostedVendorFetch: jest.fn(async (url, init) => {
    mockView.calls += 1;
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (String(init?.headers?.Authorization || '') !== 'Bearer owner-user-token') return json(401, {});
    const path = new URL(url).pathname;
    if (path === '/user/installations') {
      return json(200, { installations: [{ id: 7001, app_id: 424242, suspended_at: mockView.suspended ? '2026-11-01' : null }] });
    }
    if (path === '/user/installations/7001/repositories') {
      return json(200, { repositories: mockView.listed ? [{
        id: mockView.repositoryId, name: 'Widget', full_name: 'Outside-Team/Widget', owner: { login: 'Outside-Team' },
        permissions: { pull: true, push: mockView.push },
      }] : [] });
    }
    return json(404, {});
  }),
}));
jest.mock('../../services/hostedMcpCredentialService', () => ({
  credentialFor: jest.fn(async (row) => ({ token: String(row.config?.credentialRef || ''), expiresAt: '' })),
}));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const ApprovalAction = require('../../models/ApprovalAction');
const { mintGrant } = require('../../services/roomGrantService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { dispatchHostedBrokerTool, hostedBrokerToolsForRun } = require('../../services/grantBrokerProjectionService');
const { resolveApproval } = require('../../services/approvalActionService');
const github = require('../../services/githubAppService');
const AgentEventService = require('../../services/agentEventService');

jest.setTimeout(60000);
beforeAll(setupMongoDb);
afterAll(closeMongoDb);

let owner;
let member;
let seat;
let pod;
let ownerGithub;

const ENV_KEYS = ['GITHUB_CONNECT_APP_ID', 'GITHUB_CONNECT_APP_PRIVATE_KEY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'];
const savedEnv = {};
beforeAll(() => { ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; }); });
afterAll(() => { ENV_KEYS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }); });

const head = () => `seat/${seat._id}/fix-12`;
const prArgs = (over = {}) => ({
  title: 'Fix #12', head: head(), base: 'main', body: 'Closes #12', ...over, 
});

const RoomGrant = require('../../models/RoomGrant');

beforeEach(async () => {
  mockTrail.length = 0;
  mockEmits.length = 0;
  jest.clearAllMocks();
  process.env.GITHUB_CONNECT_APP_ID = '424242';
  process.env.GITHUB_CONNECT_APP_PRIVATE_KEY = 'connect-pem-placeholder';
  // The tools App is configured throughout, so a fallback to it would have something to use.
  process.env.GITHUB_APP_ID = '111';
  process.env.GITHUB_APP_PRIVATE_KEY = 'tools-pem-placeholder';
  github.getBranchHead.mockImplementation(async ({ branch }) => (branch === 'main' ? '1'.repeat(40) : null));
  Object.assign(mockView, { push: true, repositoryId: 555, listed: true, suspended: false, calls: 0 });
  require('../../services/githubConnectReproof')._resetConnectProofCache();
  delete process.env.SEAT_GITHUB_PUSH_ENABLED;
  mockJudge.mockResolvedValue({ refusal: null, scope: 'seat' });
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), Integration.deleteMany({}),
    ApprovalAction.deleteMany({}), RoomGrant.deleteMany({}),
    require('../../models/AgentRegistry').AgentInstallation.deleteMany({})]);
  owner = await User.create({ username: 'outside-owner', email: 'outside-owner@example.test', password: 'pw-123456' });
  member = await User.create({ username: 'other-member', email: 'other@example.test', password: 'pw-123456' });
  seat = await User.create({
    username: 'helper-seat',
    email: 'helper@agents.commonly.local',
    password: 'pw-123456',
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName: 'helper', instanceId: 'default' }, 
  });
  pod = await Pod.create({
    name: 'Outside PR pod',
    type: 'team',
    createdBy: owner._id,
    members: [owner._id, member._id, seat._id],
    publicRead: false,
    joinPolicy: 'invite-only', 
  });
  await require('../../models/AgentRegistry').AgentInstallation.create({
    agentName: 'helper',
    instanceId: 'default',
    podId: pod._id,
    installedBy: owner._id,
    version: '1.0.0',
    status: 'active',
    config: { runtime: { runtimeType: 'native' } },
  });
  // The owner's own GitHub connection (D248): the user token every re-proof reads.
  ownerGithub = await Integration.create({
    type: 'hosted-mcp', scope: 'user', status: 'connected', createdBy: owner._id, isActive: true,
    config: { entryId: 'github-mcp', credentialRef: 'owner-user-token', intake: 'oauth' },
  });
});

/** A per-repository row as the F172 routes write it: no top-level installationId. */
const connectRow = (app) => Integration.create({
  type: 'github-app',
  scope: 'user',
  status: 'connected',
  createdBy: owner._id,
  isActive: true,
  config: {
    ...(app ? { app } : {}),
    installationId: '7001',
    owner: 'Outside-Team',
    repo: 'Widget',
    repoKey: `${app || 'tools'}-outside-team/widget`,
    ...(app === 'connect' ? { repositoryId: '555' } : {}),
  },
});

const grantOn = async (row) => {
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  return mintGrant({
    connectionId: String(row._id),
    connectionRowId: String(row._id),
    installationId: '7001',
    target: { kind: 'pod', id: String(pod._id) },
    tools: ['github.get_issue', 'github.create_pull_request', 'github.commit_files'],
    writeMode: 'write-with-confirm',
    prWrite: true,
    audience: [String(seat._id)],
    expiresAt: new Date(Date.now() + 7 * 86400000),
    brokerId: GRANT_BROKER_ID,
    ownerId: String(owner._id),
  });
};

const callFromHostedTurn = async (args = prArgs()) => {
  const projection = await hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) });
  return dispatchHostedBrokerTool({
    projection,
    name: 'github_create_pull_request',
    args,
    agentUserId: String(seat._id),
    agentName: 'helper',
    instanceId: 'default',
    runPodId: String(pod._id),
  });
};

test('a PR write on a Connect connection parks for the owner and runs, signed by Connect, only on approval', async () => {
  const row = await connectRow('connect');
  await grantOn(row);
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'pending_approval', content: { status: 'pending_approval' } });
  expect(github.createPullRequest).not.toHaveBeenCalled();
  const approvalId = String(answer.content.approvalId);
  const parked = await ApprovalAction.findById(approvalId).lean();
  expect(String(parked.ownerUserId)).toBe(String(owner._id));

  // Nobody else's decision runs it.
  expect((await resolveApproval({ approvalId, callerUserId: String(member._id), decision: 'approved' })).status).toBe(403);
  expect((await resolveApproval({ approvalId, callerUserId: String(seat._id), decision: 'approved' })).status).toBe(403);
  expect(github.createPullRequest).not.toHaveBeenCalled();

  const decided = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(decided.status).toBe(200);
  expect(github.createPullRequest).toHaveBeenCalledTimes(1);
  expect(github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
    owner: 'Outside-Team',
    repo: 'Widget',
    installationId: '7001',
    app: 'connect',
    repositoryId: '555',
    forceApp: true,
    head: head(),
    base: 'main',
  }));
});

test('a legacy row with no app runs signed by the tools App', async () => {
  const row = await connectRow(undefined);
  await grantOn(row);
  const answer = await callFromHostedTurn();
  const approvalId = String(answer.content.approvalId);
  await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ installationId: '7001', app: 'tools' }));
});

test('the seat head prefix still holds on a Connect connection', async () => {
  await grantOn(await connectRow('connect'));
  const foreign = await callFromHostedTurn(prArgs({ head: 'main' }));
  expect(foreign).toMatchObject({ outcome: 'refused', content: { error: 'branch_not_owned_by_seat' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
});

test('with no Connect key the call is refused before parking, and never runs on the tools key', async () => {
  delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY;
  await grantOn(await connectRow('connect'));
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'github_app_not_configured' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
  expect(github.createPullRequest).not.toHaveBeenCalled();
});

test('a key removed after parking refuses at execution', async () => {
  await grantOn(await connectRow('connect'));
  const answer = await callFromHostedTurn();
  const approvalId = String(answer.content.approvalId);
  delete process.env.GITHUB_CONNECT_APP_ID;
  await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(github.createPullRequest).not.toHaveBeenCalled();
});

test('a row naming an unknown App is refused, not signed with either key', async () => {
  const row = await connectRow('connect');
  await Integration.collection.updateOne({ _id: row._id }, { $set: { 'config.app': 'elsewhere' } });
  await grantOn(row);
  const answer = await callFromHostedTurn();
  expect(answer.outcome).toBe('refused');
  expect(await ApprovalAction.countDocuments({})).toBe(0);
  expect(github.createPullRequest).not.toHaveBeenCalled();
});

// ─── HOLD 1: the owner's access is proved again on every write ───────────────

const parkPr = async () => {
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'pending_approval' });
  return String(answer.content.approvalId);
};

test('the park re-proves the owner with their current user token', async () => {
  await grantOn(await connectRow('connect'));
  await parkPr();
  expect(mockView.calls).toBeGreaterThan(0);
});

test('an owner who lost push is refused at park, and nothing parks or reaches GitHub', async () => {
  await grantOn(await connectRow('connect'));
  mockView.push = false;
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'connection_unproven' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(mockTrail.at(-1)).toMatchObject({ outcome: 'refused', reason: 'connection_unproven' });
});

test('push lost between park and approval: the approved call is refused and never runs', async () => {
  await grantOn(await connectRow('connect'));
  const approvalId = await parkPr();
  // Within the park cache window: execution must not rely on that cache.
  mockView.push = false;
  await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(mockTrail.at(-1)).toMatchObject({ outcome: 'refused', reason: 'connection_unproven' });
});

test.each([
  ['the repository was replaced by another with the same name', () => { mockView.repositoryId = 999; }],
  ['the repository is no longer in the installation', () => { mockView.listed = false; }],
  ['the installation is suspended', () => { mockView.suspended = true; }],
])('refused at park when %s', async (_label, change) => {
  await grantOn(await connectRow('connect'));
  change();
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'connection_unproven' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
});

test('a Connect row with no recorded repository id is refused', async () => {
  const row = await connectRow('connect');
  await Integration.updateOne({ _id: row._id }, { $unset: { 'config.repositoryId': 1 } });
  await grantOn(row);
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'connection_unproven' } });
});

test('a tools row is not re-proved', async () => {
  await grantOn(await connectRow(undefined));
  await parkPr();
  expect(mockView.calls).toBe(0);
});

test('removing the owner\'s GitHub connection disconnects their Connect rows, revokes the grants, and calls refuse', async () => {
  const row = await connectRow('connect');
  const grant = await grantOn(row);
  const approvalId = await parkPr();
  const { removeConnection } = require('../../services/connectionRemovalService');
  const { revokeConnectionGrants } = require('../../services/roomGrantService');
  await removeConnection({
    connection: (await Integration.findById(ownerGithub._id).lean()),
    removedBy: String(owner._id),
    revokeGrants: revokeConnectionGrants,
    // Only the vendor side is stubbed; the dependent-row step is the real one.
    deps: {
      clientIdFor: () => 'client', clientSecretFor: () => 'secret',
      revokeAtVendor: async () => {},
      secrets: { get: async () => 'owner-user-token', revoke: async () => {}, writeGenerationOf: async () => 0 },
    },
  });
  expect((await Integration.findById(row._id).lean()).status).toBe('disconnected');
  expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).revokedAt).toBeTruthy();
  await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(github.createPullRequest).not.toHaveBeenCalled();
});

test('a revoke that fails after the row is disconnected is finished by the retry', async () => {
  const row = await connectRow('connect');
  const grant = await grantOn(row);
  const { removeConnection } = require('../../services/connectionRemovalService');
  const { revokeConnectionGrants } = require('../../services/roomGrantService');
  const deps = {
    clientIdFor: () => 'client', clientSecretFor: () => 'secret',
    revokeAtVendor: async () => {},
    secrets: { get: async () => 'owner-user-token', revoke: async () => {}, writeGenerationOf: async () => 0 },
  };
  let failConnectRevoke = true;
  const revokeGrants = async (input) => {
    if (failConnectRevoke && String(input.connection._id) === String(row._id)) {
      failConnectRevoke = false;
      throw new Error('revoke store down');
    }
    return revokeConnectionGrants(input);
  };
  const attempt = () => Integration.findById(ownerGithub._id).lean().then((connection) => removeConnection({
    connection, removedBy: String(owner._id), revokeGrants, deps,
  }));
  await expect(attempt()).rejects.toThrow('revoke store down');
  expect((await Integration.findById(row._id).lean()).status).toBe('disconnected');
  expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).revokedAt).toBeFalsy();
  await attempt();
  expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).revokedAt).toBeTruthy();
  expect((await Integration.findById(row._id).lean()).status).toBe('disconnected');
});

test('with the GitHub connection gone (not yet swept), a Connect call refuses connection_unproven', async () => {
  await grantOn(await connectRow('connect'));
  await Integration.deleteOne({ _id: ownerGithub._id });
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'connection_unproven' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
});

// ─── M1/M2: the Git Data writes are signed by Connect, narrowed to the repo ──

test('an approved commit_files on Connect signs every Git Data call with Connect, narrowed to the repository', async () => {
  await grantOn(await connectRow('connect'));
  github.getCommitTree.mockResolvedValue('3'.repeat(40));
  github.createTextTree.mockResolvedValue('4'.repeat(40));
  github.createCommit.mockResolvedValue('5'.repeat(40));
  const answer = await dispatchHostedBrokerTool({
    projection: await hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) }),
    name: 'github_commit_files',
    args: { branch: head(), base: 'main', message: 'Fix', files: [{ path: 'src/a.js', content: 'a' }] },
    agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default', runPodId: String(pod._id),
  });
  expect(answer.outcome).toBe('pending_approval');
  await resolveApproval({ approvalId: String(answer.content.approvalId), callerUserId: String(owner._id), decision: 'approved' });
  expect(github.createBranchRef).toHaveBeenCalledTimes(1);
  const gitCalls = ['getDefaultBranch', 'getBranchHead', 'getCommitTree', 'getTreeEntries', 'createTextTree',
    'createCommit', 'createBranchRef'].flatMap((name) => github[name].mock.calls.map(([options]) => [name, options]));
  expect(gitCalls.length).toBeGreaterThan(6);
  for (const [, options] of gitCalls) {
    expect(options).toMatchObject({ installationId: '7001', app: 'connect', repositoryId: '555', forceApp: true });
  }
});

// ─── F173: reads are re-proved too; an unparked write never uses the cache ───

const fullWriteGrantOn = async (row) => {
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  return mintGrant({
    connectionId: String(row._id),
    connectionRowId: String(row._id),
    installationId: '7001',
    target: { kind: 'pod', id: String(pod._id) },
    tools: ['github.get_issue', 'github.list_issues', 'github.get_pull_request', 'github.list_pull_request_files', 'github.close_issue'],
    writeMode: 'write',
    audience: [String(seat._id)],
    expiresAt: new Date(Date.now() + 7 * 86400000),
    brokerId: GRANT_BROKER_ID,
    ownerId: String(owner._id),
  });
};

const callTool = async (name, args) => dispatchHostedBrokerTool({
  projection: await hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) }),
  name,
  args,
  agentUserId: String(seat._id),
  agentName: 'helper',
  instanceId: 'default',
  runPodId: String(pod._id),
});

const READS = [
  ['github_get_issue', { issueNumber: 12 }, 'getIssue'],
  ['github_list_issues', {}, 'listOpenIssues'],
  ['github_get_pull_request', { pullNumber: 5 }, 'getPullRequest'],
  ['github_list_pull_request_files', { pullNumber: 5 }, 'listPullRequestFiles'],
];

describe('F173: Connect reads re-prove the owner', () => {
  test.each(READS)('%s runs on a proven Connect row and re-proves first', async (name, args, method) => {
    await fullWriteGrantOn(await connectRow('connect'));
    const answer = await callTool(name, args);
    expect(answer.outcome).not.toBe('refused');
    expect(mockView.calls).toBeGreaterThan(0);
    expect(github[method]).toHaveBeenCalled();
  });

  test.each(READS)('%s refuses after the owner loses push, before GitHub is touched', async (name, args, method) => {
    await fullWriteGrantOn(await connectRow('connect'));
    mockView.push = false;
    const answer = await callTool(name, args);
    expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'connection_unproven' } });
    expect(github[method]).not.toHaveBeenCalled();
  });

  test.each(READS)('%s refuses when the repository is gone from the installation', async (name, args, method) => {
    await fullWriteGrantOn(await connectRow('connect'));
    mockView.listed = false;
    const answer = await callTool(name, args);
    expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'connection_unproven' } });
    expect(github[method]).not.toHaveBeenCalled();
  });

  test('a read on a tools row is not re-proved', async () => {
    await fullWriteGrantOn(await connectRow(undefined));
    const answer = await callTool('github_get_issue', { issueNumber: 12 });
    expect(answer.outcome).not.toBe('refused');
    expect(mockView.calls).toBe(0);
  });

  test('reads share the 60s cache: a second read inside the window does not ask GitHub again', async () => {
    await fullWriteGrantOn(await connectRow('connect'));
    await callTool('github_get_issue', { issueNumber: 12 });
    const after = mockView.calls;
    await callTool('github_get_issue', { issueNumber: 12 });
    expect(mockView.calls).toBe(after);
  });
});

describe('F173: a write that runs without a parked approval proves fresh', () => {
  // A hosted turn only gets reads and the PR writes, which always park; a
  // reversible write on a full-write grant runs unattended from a seat.
  // close_issue was the one such write, and F174 refuses issue writes on
  // Connect rows outright, so no built-in tool reaches this path on Connect
  // today. These tests lift that refusal for close_issue alone, to keep the
  // fresh-proof rule covered for the next unparked write that does.
  const { CONNECT_UNSUPPORTED_TOOLS } = require('../../services/toolBrokerService');
  beforeEach(() => { CONNECT_UNSUPPORTED_TOOLS.delete('github.close_issue'); });
  afterEach(() => { CONNECT_UNSUPPORTED_TOOLS.add('github.close_issue'); });
  const closeDirect = (grant) => require('../../services/toolBrokerService').callTool({
    grantId: grant.grantId, agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default',
    tool: 'github.close_issue', args: { issueNumber: 12 },
  });

  test('a full-write close_issue runs directly, re-proved', async () => {
    const grant = await fullWriteGrantOn(await connectRow('connect'));
    await closeDirect(grant);
    expect(mockView.calls).toBeGreaterThan(0);
    expect(github.closeIssue).toHaveBeenCalled();
    expect(await ApprovalAction.countDocuments({})).toBe(0);
  });

  test('an unparked write ignores a proof cached a moment ago', async () => {
    const grant = await fullWriteGrantOn(await connectRow('connect'));
    // A read caches a passing proof for this row.
    expect((await callTool('github_get_issue', { issueNumber: 12 })).outcome).not.toBe('refused');
    mockView.push = false;
    await expect(closeDirect(grant)).rejects.toMatchObject({ code: 'connection_unproven' });
    expect(github.closeIssue).not.toHaveBeenCalled();
  });
});

// ─── F174 ───────────────────────────────────────────────────────────────────

const broker = () => require('../../services/toolBrokerService');
const grantTools = async (row, tools, writeMode = 'write-with-confirm') => {
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  return mintGrant({
    connectionId: String(row._id), connectionRowId: String(row._id), installationId: '7001',
    target: { kind: 'pod', id: String(pod._id) }, tools, writeMode,
    audience: [String(seat._id)], expiresAt: new Date(Date.now() + 7 * 86400000),
    brokerId: GRANT_BROKER_ID, ownerId: String(owner._id),
  });
};
const seatCall = (grant, tool, args) => broker().callTool({
  grantId: grant.grantId, agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default', tool, args,
});

describe('F174 item 1: a grant runs only for the row owner who minted it', () => {
  // The new owner can prove the repository too, so only the owner check refuses.
  beforeEach(() => Integration.create({
    type: 'hosted-mcp', scope: 'user', status: 'connected', createdBy: member._id, isActive: true,
    config: { entryId: 'github-mcp', credentialRef: 'owner-user-token', intake: 'oauth' },
  }));

  test('a Connect row whose owner changed refuses the old owner\'s grant at park, before GitHub', async () => {
    const row = await connectRow('connect');
    const grant = await grantTools(row, ['github.get_issue']);
    await Integration.updateOne({ _id: row._id }, { $set: { createdBy: member._id } });
    await expect(seatCall(grant, 'github.get_issue', { issueNumber: 12 }))
      .rejects.toMatchObject({ code: 'connection_owner_changed' });
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  test('an owner change between park and approval refuses the approved call', async () => {
    const row = await connectRow('connect');
    await grantOn(row);
    const approvalId = await parkPr();
    await Integration.updateOne({ _id: row._id }, { $set: { createdBy: member._id } });
    await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
    expect(github.createPullRequest).not.toHaveBeenCalled();
  });

  test('a tools row is unchanged: an owner change does not refuse its grant', async () => {
    const row = await connectRow(undefined);
    const grant = await grantTools(row, ['github.get_issue']);
    await Integration.updateOne({ _id: row._id }, { $set: { createdBy: member._id } });
    await seatCall(grant, 'github.get_issue', { issueNumber: 12 });
    expect(github.getIssue).toHaveBeenCalled();
  });
});

describe('F174 item 6: Commonly Connect cannot write issues', () => {
  const ISSUE_WRITES = [
    ['github.create_issue', { title: 'A bug', body: 'details' }, 'createIssue'],
    ['github.close_issue', { issueNumber: 12 }, 'closeIssue'],
    ['github.comment_on_issue', { issueNumber: 12, body: 'hello' }, 'addIssueComment'],
  ];
  const MESSAGE = 'This GitHub connection can read issues but can\'t create, close or comment on them. Nothing was changed on GitHub.';

  test.each(ISSUE_WRITES)('%s on a Connect row refuses before parking, plainly, not retryable', async (tool, args, method) => {
    const grant = await grantTools(await connectRow('connect'), [tool]);
    const error = await seatCall(grant, tool, args).then(() => null, (e) => e);
    expect(error).toMatchObject({
      code: 'connection_cannot_write_issues',
      message: MESSAGE,
      statusCode: 403,
      details: expect.objectContaining({ retryable: false }),
    });
    expect(await ApprovalAction.countDocuments({})).toBe(0);
    expect(github[method]).not.toHaveBeenCalled();
    expect(mockView.calls).toBe(0);
  });

  test.each(ISSUE_WRITES)('%s on a full write grant also refuses (no unparked path)', async (tool, args, method) => {
    const grant = await grantTools(await connectRow('connect'), [tool], 'write');
    await expect(seatCall(grant, tool, args)).rejects.toMatchObject({ code: 'connection_cannot_write_issues' });
    expect(github[method]).not.toHaveBeenCalled();
  });

  test('the refusal text reaches the agent intact through the MCP error payload', async () => {
    const grant = await grantTools(await connectRow('connect'), ['github.create_issue']);
    const error = await seatCall(grant, 'github.create_issue', { title: 'A bug' }).then(() => null, (e) => e);
    const { errorPayload } = require('../../routes/mcpGrants');
    expect(errorPayload(error)).toMatchObject({ error: 'connection_cannot_write_issues', message: MESSAGE });
  });

  test('a tools row still parks an issue write for approval', async () => {
    const grant = await grantTools(await connectRow(undefined), ['github.create_issue']);
    await expect(seatCall(grant, 'github.create_issue', { title: 'A bug' }))
      .rejects.toMatchObject({ code: 'approval_required' });
  });

  test('the grant tool list leaves issue writes off a Connect row, and keeps them on a tools row', async () => {
    const tools = ['github.get_issue', 'github.create_issue', 'github.close_issue', 'github.comment_on_issue',
      'github.comment_on_pull_request'];
    const listFor = async (row) => (await broker().listToolsForGrant({
      grantId: (await grantTools(row, tools)).grantId, agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default',
    })).map((d) => d.name).sort();
    expect(await listFor(await connectRow('connect'))).toEqual(['github.comment_on_pull_request', 'github.get_issue']);
    await Integration.deleteMany({ type: 'github-app' });
    expect(await listFor(await connectRow(undefined))).toEqual([...tools].sort());
  });
});

describe('F174 item 2: the old owner\'s retire never touches a taken-over row', () => {
  test('a stale read of a row Bob now owns: the row stays connected and Bob\'s grant lives', async () => {
    const row = await connectRow('connect');
    // The row has since been taken over by `member`, who minted a grant on it.
    await Integration.updateOne({ _id: row._id }, { $set: { createdBy: member._id } });
    const takersGrant = await mintGrant({
      connectionId: String(row._id), connectionRowId: String(row._id), installationId: '7001',
      target: { kind: 'pod', id: String(pod._id) }, tools: ['github.get_issue'], writeMode: 'read',
      audience: [String(seat._id)], expiresAt: new Date(Date.now() + 86400000),
      brokerId: GRANT_BROKER_ID, ownerId: String(member._id),
    });
    const stale = { ...(await Integration.findById(row._id).lean()), createdBy: owner._id };
    const find = jest.spyOn(Integration, 'find').mockReturnValueOnce({ lean: async () => [stale] });
    const { defaultDeps } = require('../../services/connectionRemovalService');
    const { revokeConnectionGrants } = require('../../services/roomGrantService');
    try {
      await defaultDeps().retireConnectRepositories({
        ownerUserId: String(owner._id), revokedBy: String(owner._id), revokeGrants: revokeConnectionGrants,
      });
    } finally { find.mockRestore(); }
    expect((await Integration.findById(row._id).lean()).status).toBe('connected');
    expect((await RoomGrant.findOne({ grantId: takersGrant.grantId }).lean()).revokedAt).toBeFalsy();
  });
});
