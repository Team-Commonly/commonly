/**
 * TASK-783 end to end, below the HTTP layer: a hosted agent's
 * `github.create_pull_request` on a `prWrite` grant parks as an ApprovalAction,
 * and only the connection owner's approval runs it, once, with the parked
 * arguments. RoomGrant, ApprovalAction, Pod, User and Integration are real
 * (memory Mongo), as are the broker, the grant service and the approval
 * service. GitHub, the PostgreSQL call trail and the message/event fan-out are
 * module mocks.
 */
process.env.PG_HOST = '';
process.env.JWT_SECRET = 'pr-write-approval-test-only';
const { createHash } = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
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
  getCommitTree: jest.fn(), createTextTree: jest.fn(), createCommit: jest.fn(),
  createBranchRef: jest.fn(), fastForwardBranchRef: jest.fn(), getInstallationToken: jest.fn(),
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
jest.mock('../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../models/Message', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../../services/brokerRecordService', () => ({
  recordBrokerCall: jest.fn(), recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(), recordGrantsRevoked: jest.fn(), recordGrantIssued: jest.fn(),
}));
// The pod gate has its own suites; here the pod is eligible.
jest.mock('../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => reason),
}));

const mongoose = require('mongoose');
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
let grant;

const head = () => `seat/${seat._id}/fix-12`;
const prArgs = (over = {}) => ({ title: 'Fix #12', head: head(), base: 'main', body: 'Closes #12', ...over });

beforeEach(async () => {
  mockTrail.length = 0;
  jest.clearAllMocks();
  delete process.env.SEAT_GITHUB_PUSH_ENABLED;
  mockJudge.mockResolvedValue({ refusal: null, scope: 'seat' });
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), Integration.deleteMany({}),
    ApprovalAction.deleteMany({}), require('../../models/RoomGrant').deleteMany({})]);
  owner = await User.create({ username: 'repo-owner', email: 'repo-owner@example.test', password: 'pw-123456' });
  member = await User.create({ username: 'other-member', email: 'other@example.test', password: 'pw-123456' });
  seat = await User.create({ username: 'helper-seat', email: 'helper@agents.commonly.local', password: 'pw-123456',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'helper', instanceId: 'default' } });
  pod = await Pod.create({ name: 'PR pod', type: 'team', createdBy: owner._id,
    members: [owner._id, member._id, seat._id], publicRead: false, joinPolicy: 'invite-only' });
  await Integration.create({ type: 'github-app', status: 'connected', createdBy: owner._id,
    podId: pod._id, installationId: 'gh-inst-1',
    config: { installationId: 'gh-inst-1', owner: 'Team-Commonly', repo: 'commonly' } });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  grant = await mintGrant({
    connectionId: 'gh-inst-1', installationId: 'gh-inst-1', target: { kind: 'pod', id: String(pod._id) },
    tools: ['github.get_issue', 'github.create_pull_request', 'github.commit_files'],
    writeMode: 'write-with-confirm', prWrite: true, audience: [String(seat._id)],
    expiresAt: new Date(Date.now() + 7 * 86400000), brokerId: GRANT_BROKER_ID, ownerId: String(owner._id),
  });
});

const callFromHostedTurn = async (args = prArgs()) => {
  const projection = await hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) });
  return dispatchHostedBrokerTool({
    projection, name: 'github_create_pull_request', args,
    agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default', runPodId: String(pod._id),
  });
};

const parkOne = async () => {
  const answer = await callFromHostedTurn();
  expect(answer).toMatchObject({ outcome: 'pending_approval', content: { status: 'pending_approval' } });
  return String(answer.content.approvalId);
};

test('a hosted call parks for the connection owner and nothing reaches GitHub', async () => {
  const approvalId = await parkOne();
  const row = await ApprovalAction.findById(approvalId).lean();
  expect(row).toMatchObject({ status: 'flagged', actionType: 'tool_call' });
  expect(String(row.ownerUserId)).toBe(String(owner._id));
  expect(row.toolCall.canonicalArgs).toEqual({ ...prArgs(), owner: 'Team-Commonly', repo: 'commonly' });
  // A parked broker call closes itself within a day.
  expect(new Date(row.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(mockTrail.map((r) => r.outcome)).toEqual(['pending_approval']);
});

test('the owner\'s approval runs exactly the parked call once; a second approval is a no-op', async () => {
  const approvalId = await parkOne();
  const first = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(first.status).toBe(200);
  expect(github.createPullRequest).toHaveBeenCalledTimes(1);
  expect(github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
    owner: 'Team-Commonly', repo: 'commonly', installationId: 'gh-inst-1', forceApp: true,
    title: 'Fix #12', head: head(), base: 'main', body: 'Closes #12',
  }));
  const second = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(second.status).toBe(409);
  expect(github.createPullRequest).toHaveBeenCalledTimes(1);
  // The agent hears the outcome on its own, with the PR number as the receipt.
  expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    type: 'approval.resolved',
    payload: expect.objectContaining({ ending: 'ran', receipt: { number: 101 } }),
  }));
  expect(mockTrail.map((r) => r.outcome)).toEqual(['pending_approval', 'ok']);
  // The envelope does not outlive the decision.
  expect((await ApprovalAction.findById(approvalId).lean()).toolCall.canonicalArgs).toBeUndefined();
});

test('two concurrent approvals run it once', async () => {
  const approvalId = await parkOne();
  const results = await Promise.all([1, 2].map(() => resolveApproval({
    approvalId, callerUserId: String(owner._id), decision: 'approved',
  })));
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(github.createPullRequest).toHaveBeenCalledTimes(1);
});

test('another pod member cannot approve, and nothing runs', async () => {
  const approvalId = await parkOne();
  const result = await resolveApproval({ approvalId, callerUserId: String(member._id), decision: 'approved' });
  expect(result.status).toBe(403);
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect((await ApprovalAction.findById(approvalId).lean()).status).toBe('flagged');
});

test('the agent itself cannot approve its own call', async () => {
  const approvalId = await parkOne();
  const result = await resolveApproval({ approvalId, callerUserId: String(seat._id), decision: 'approved' });
  expect(result.status).toBe(403);
  expect(github.createPullRequest).not.toHaveBeenCalled();
});

test('a rejection closes it without running', async () => {
  const approvalId = await parkOne();
  const result = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'declined' });
  expect(result.status).toBe(200);
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(mockTrail.at(-1)).toMatchObject({ outcome: 'refused', reason: 'approval_declined' });
  const again = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(again.status).toBe(409);
  expect(github.createPullRequest).not.toHaveBeenCalled();
});

test('an expired approval closes without running', async () => {
  const approvalId = await parkOne();
  await ApprovalAction.updateOne({ _id: approvalId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const result = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
  expect(result.status).toBe(409);
  expect(result.body.error).toBe('expired');
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(mockTrail.at(-1)).toMatchObject({ outcome: 'refused', reason: 'approval_expired' });
});

test('a head outside the seat\'s own prefix is refused and nothing is parked', async () => {
  const answer = await callFromHostedTurn(prArgs({ head: 'main' }));
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'branch_not_owned_by_seat' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
});

test('a grant minted without prWrite offers no PR tool and parks nothing', async () => {
  await require('../../models/RoomGrant').updateOne({ grantId: grant.grantId }, { $unset: { prWrite: 1 } });
  const projection = await hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) });
  expect(projection.tools.map((t) => t.function.name)).toEqual(['github_get_issue']);
  // A hand-built dispatch entry (what a stale projection would hold) still refuses.
  const answer = await dispatchHostedBrokerTool({
    projection: { tools: [], dispatch: new Map([['x', { grantId: grant.grantId, tool: 'github.create_pull_request' }]]) },
    name: 'x', args: prArgs(), agentUserId: String(seat._id), agentName: 'helper', runPodId: String(pod._id),
  });
  expect(answer).toMatchObject({ outcome: 'refused', content: { error: 'pr_write_not_granted' } });
  expect(await ApprovalAction.countDocuments({})).toBe(0);
});

test('digests in the trail are of the parked envelope', async () => {
  await parkOne();
  const envelope = { ...prArgs(), owner: 'Team-Commonly', repo: 'commonly' };
  expect(mockTrail[0].argsDigest).toBe(createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
  expect(mongoose.connection.readyState).toBe(1);
});

describe('the call is judged again when it is approved', () => {
  test('revoking the grant between park and approve: nothing reaches GitHub', async () => {
    const approvalId = await parkOne();
    await require('../../services/roomGrantService').revokeGrant(grant.grantId, String(owner._id));
    const result = await resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
    expect(result.status).toBe(200);
    expect(github.createPullRequest).not.toHaveBeenCalled();
    const row = await ApprovalAction.findById(approvalId).lean();
    expect(row).toMatchObject({ toolCallEnding: 'refused', toolCallCode: 'grant_revoked' });
    expect(mockTrail.at(-1)).toMatchObject({ outcome: 'refused', reason: 'grant_revoked', approvalId });
  });

  describe('a BYO seat the grant names', () => {
    const { AgentInstallation } = require('../../models/AgentRegistry');
    let byoGrant;
    beforeEach(async () => {
      await AgentInstallation.deleteMany({});
      await AgentInstallation.create({
        agentName: 'helper', instanceId: 'default', podId: pod._id, installedBy: owner._id,
        version: '1.0.0', status: 'active', config: { runtime: { runtimeType: 'claude-code' } },
      });
      // Not confined: only the naming lets it use the grant.
      mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_absent', detail: 'no sandbox' }, scope: 'seat' });
      byoGrant = await mintGrant({
        connectionId: 'gh-inst-1', installationId: 'gh-inst-1', target: { kind: 'pod', id: String(pod._id) },
        tools: ['github.create_pull_request'], writeMode: 'write-with-confirm', prWrite: true,
        audience: [String(seat._id)], byoAgents: [String(seat._id)],
        byoConsent: { by: String(owner._id), at: new Date(), version: 'byo-v1',
          agents: [{ userId: String(seat._id), sandbox: 'unconfined' }] },
        expiresAt: new Date(Date.now() + 86400000), brokerId: GRANT_BROKER_ID, ownerId: String(owner._id),
      });
    });

    const parkByo = async () => {
      await expect(require('../../services/toolBrokerService').callTool({
        grantId: byoGrant.grantId, agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default',
        tool: 'github.create_pull_request', args: prArgs(),
      })).rejects.toMatchObject({ code: 'approval_required' });
      return String((await ApprovalAction.findOne({ actionType: 'tool_call' }).lean())._id);
    };
    const approve = (approvalId) => resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });

    test('still named, still the same sandbox: the approval runs', async () => {
      const approvalId = await parkByo();
      expect(mockTrail[0]).toMatchObject({ outcome: 'pending_approval', callerConfinement: 'named_unconfined' });
      expect((await approve(approvalId)).status).toBe(200);
      expect(github.createPullRequest).toHaveBeenCalledTimes(1);
    });

    test('un-named between park and approve (the granter\'s remove): nothing reaches GitHub', async () => {
      const approvalId = await parkByo();
      const agentId = String(seat._id);
      await require('../../models/RoomGrant').updateMany({ grantId: byoGrant.grantId },
        { $pull: { byoAgents: agentId, audience: agentId, 'byoConsent.agents': { userId: agentId } } });
      expect((await approve(approvalId)).status).toBe(200);
      expect(github.createPullRequest).not.toHaveBeenCalled();
      expect((await ApprovalAction.findById(approvalId).lean()).toolCallEnding).toBe('refused');
    });

    test('naming withdrawn while the seat stays in the audience: confinement_changed', async () => {
      const approvalId = await parkByo();
      await require('../../models/RoomGrant').updateOne({ grantId: byoGrant.grantId },
        { $pull: { byoAgents: String(seat._id) } });
      await approve(approvalId);
      expect(github.createPullRequest).not.toHaveBeenCalled();
      expect(await ApprovalAction.findById(approvalId).lean())
        .toMatchObject({ toolCallEnding: 'refused', toolCallCode: 'confinement_changed' });
    });

    test('the seat moved to an adapter naming cannot lift: confinement_changed', async () => {
      const approvalId = await parkByo();
      mockJudge.mockResolvedValue({ refusal: { reason: 'adapter_cannot_confine', detail: 'no' }, scope: 'seat' });
      await approve(approvalId);
      expect(github.createPullRequest).not.toHaveBeenCalled();
      expect((await ApprovalAction.findById(approvalId).lean()).toolCallCode).toBe('confinement_changed');
    });

    test('a seat that was confined at park and is not now: confinement_changed', async () => {
      mockJudge.mockResolvedValue({ refusal: null, scope: 'seat' });
      const approvalId = await parkByo();
      expect(mockTrail[0].callerConfinement).toBe('confined');
      await require('../../models/RoomGrant').updateOne({ grantId: byoGrant.grantId }, { $set: { byoAgents: [] } });
      mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_absent', detail: 'gone' }, scope: 'seat' });
      await approve(approvalId);
      expect(github.createPullRequest).not.toHaveBeenCalled();
      expect((await ApprovalAction.findById(approvalId).lean()).toolCallCode).toBe('confinement_changed');
    });
  });
});

describe('the owner\'s card carries a summary, never the payload', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/approvals', require('../../routes/approvals'));
  const bearer = (person) => `Bearer ${jwt.sign({ id: String(person._id), tokenVersion: 0 }, process.env.JWT_SECRET)}`;
  const pending = async (person) => {
    const res = await request(app).get(`/api/approvals/pending?podId=${pod._id}`).set('Authorization', bearer(person));
    expect(res.status).toBe(200);
    return res.body.approvals;
  };
  const BUNDLE = Buffer.from('a git bundle that must stay server-side '.repeat(64)).toString('base64');

  const parkPush = async () => {
    process.env.SEAT_GITHUB_PUSH_ENABLED = 'true';
    await require('../../models/RoomGrant').updateOne({ grantId: grant.grantId },
      { $addToSet: { tools: 'github.push_branch' } });
    await expect(require('../../services/toolBrokerService').callTool({
      grantId: grant.grantId, agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default',
      tool: 'github.push_branch',
      args: { ref: `refs/heads/${head()}`, baseOid: '1'.repeat(40), newOid: '2'.repeat(40), bundle: BUNDLE },
    })).rejects.toMatchObject({ code: 'approval_required' });
  };

  test('a parked push: repo, head, commit ids and bundle size; no bundle bytes anywhere', async () => {
    await parkPush();
    const stored = await ApprovalAction.findOne({ actionType: 'tool_call' }).lean();
    // Server-side, the envelope keeps the bundle it will run.
    expect(stored.toolCall.canonicalArgs.bundle).toBe(BUNDLE);
    const [card] = await pending(owner);
    expect(JSON.stringify(card)).not.toContain(BUNDLE.slice(0, 64));
    expect(card.toolCall.canonicalArgs).toBeUndefined();
    expect(card.toolCall.summary).toEqual({
      repo: 'Team-Commonly/commonly', head: head(), baseOid: '1'.repeat(40), newOid: '2'.repeat(40),
      bundleBytes: Buffer.from(BUNDLE, 'base64').length,
    });
    const [memberCard] = await pending(member);
    expect(JSON.stringify(memberCard)).not.toContain(BUNDLE.slice(0, 64));
    expect(memberCard.toolCall).toEqual({ tool: 'github.push_branch' });
    // The card message the room received carried no bundle either.
    const posted = require('../../services/agentMessageService').postMessage.mock.calls.at(-1)[0];
    expect(JSON.stringify(posted)).not.toContain(BUNDLE.slice(0, 64));
  });

  test('a parked commit: repo, base, head, subject, each path with its size, and the count', async () => {
    const content = 'export const fixed = true;\n'.repeat(10);
    const answer = await dispatchHostedBrokerTool({
      projection: await hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) }),
      name: 'github_commit_files',
      args: { branch: head(), base: 'main', message: 'Fix #12\n\nlonger body', files: [{ path: 'src/a.js', content }] },
      agentUserId: String(seat._id), agentName: 'helper', runPodId: String(pod._id),
    });
    expect(answer.outcome).toBe('pending_approval');
    const [card] = await pending(owner);
    expect(JSON.stringify(card)).not.toContain('export const fixed');
    expect(card.toolCall.summary).toEqual({
      repo: 'Team-Commonly/commonly', base: 'main', head: head(), subject: 'Fix #12',
      files: [{ path: 'src/a.js', bytes: Buffer.byteLength(content) }], fileCount: 1,
      parentSha: '1'.repeat(40), branchExists: false,
    });
  });

  test('a parked pull request: repo, base, head, title and a bounded body preview', async () => {
    await callFromHostedTurn(prArgs({ body: 'x'.repeat(5000) }));
    const [card] = await pending(owner);
    expect(card.toolCall.canonicalArgs).toBeUndefined();
    expect(card.toolCall.summary).toEqual({
      repo: 'Team-Commonly/commonly', base: 'main', head: head(), title: 'Fix #12',
      draft: false, bodyPreview: 'x'.repeat(2000), bodyLength: 5000,
    });
  });

  test('the push bundle is bounded before it can park', async () => {
    process.env.SEAT_GITHUB_PUSH_ENABLED = 'true';
    await require('../../models/RoomGrant').updateOne({ grantId: grant.grantId },
      { $addToSet: { tools: 'github.push_branch' } });
    await expect(require('../../services/toolBrokerService').callTool({
      grantId: grant.grantId, agentUserId: String(seat._id), agentName: 'helper', tool: 'github.push_branch',
      args: { ref: `refs/heads/${head()}`, baseOid: '1'.repeat(40), newOid: '2'.repeat(40), bundle: 'A'.repeat(9 * 1024 * 1024) },
    })).rejects.toMatchObject({ code: 'push_args_invalid' });
    expect(await ApprovalAction.countDocuments({})).toBe(0);
  });
});
