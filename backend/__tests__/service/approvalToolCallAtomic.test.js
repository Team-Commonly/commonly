/**
 * F184: the F180 follow-ups promised on #3488 (CodeRabbit 4477881804).
 *
 * F180 bounded the broker's approval cards with a find-then-create reuse and a
 * count-then-create cap of 3 open cards per seat and pod. Both were racy: two
 * identical calls in flight could each create a card, and four distinct calls
 * could each see 2 open and all create. A row whose card never posted (a crash
 * between create and post) held a cap slot for its whole 24 hours, and a reused
 * approval named only the run that created it.
 *
 * Real Mongo with the model's indexes built, the real broker, approval service
 * and message service. GitHub, the call trail and event fan-out are mocked.
 * The races are made deterministic with a barrier on the open-card count, so
 * every caller passes the pre-checks before any of them writes.
 */
process.env.PG_HOST = '';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/ToolCall', () => {
  const digestArgs = (args) => require('crypto').createHash('sha256')
    .update(JSON.stringify(args === undefined ? {} : args)).digest('hex');
  const create = jest.fn(async (row) => row);
  return {
    __esModule: true,
    default: { create, digestArgs },
    create,
    digestArgs,
    reserveBudgetLineage: jest.fn(async () => true),
  };
});
jest.mock('../../services/githubAppService', () => ({
  createIssue: jest.fn(async () => ({ number: 7, html_url: 'https://github.com/o/r/issues/7', title: 'Bug' })),
  getInstallationToken: jest.fn(),
}));
jest.mock('../../services/seatGrantConfinement', () => ({
  ...jest.requireActual('../../services/seatGrantConfinement'),
  judgeSeatConfinement: jest.fn(async () => ({ refusal: null, scope: 'seat' })),
}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn(async () => ({ _id: 'stub-event' })) }));
jest.mock('../../services/attentionItemService', () => ({
  ...jest.requireActual('../../services/attentionItemService'),
  recordActionApproval: jest.fn(async () => undefined),
  resolve: jest.fn(async () => undefined),
  resolveExpired: jest.fn(async () => undefined),
  recordMentionedUsers: jest.fn(async () => undefined),
  resolveMentionAttentionForReply: jest.fn(async () => undefined),
}));
jest.mock('../../services/brokerRecordService', () => ({
  recordBrokerCall: jest.fn(),
  recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(),
  recordGrantsRevoked: jest.fn(),
  recordGrantIssued: jest.fn(),
}));
jest.mock('../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => reason),
}));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const Integration = require('../../models/Integration');
const ApprovalAction = require('../../models/ApprovalAction');
const RoomGrant = require('../../models/RoomGrant');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const { mintGrant } = require('../../services/roomGrantService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { resolveApproval } = require('../../services/approvalActionService');
const AgentMessageService = require('../../services/agentMessageService');
const github = require('../../services/githubAppService');
const ToolCall = require('../../models/ToolCall');

const JWT_SECRET = 'approval-atomic-test-only';
const AgentEventService = require('../../services/agentEventService');
const { sweepCardlessToolCallApprovals } = require('../../services/approvalActionService');

jest.setTimeout(60000);

let app;
let human;
let humanToken;
let pod;
let seat;
let seatToken;
let grant;

const installAndIssueToken = async (agentName) => {
  await request(app).post('/api/registry/install').set('Authorization', `Bearer ${humanToken}`)
    .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
  const res = await request(app).post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
    .set('Authorization', `Bearer ${humanToken}`).send({ label: `${agentName} token` });
  expect(res.status).toBe(200);
  return res.body.token;
};

const agentPost = (content, extra = {}) => request(app)
  .post(`/api/agents/runtime/pods/${pod._id}/messages`)
  .set('Authorization', `Bearer ${seatToken}`)
  .send({ content, ...extra });

const stored = () => Message.find({ podId: pod._id }).sort({ createdAt: 1 }).lean();
const cards = async () => (await stored()).filter((m) => m.messageType === 'card');

const ISSUE = { title: 'Bug', body: 'It breaks.' };
const callIssue = (args = ISSUE) => require('../../services/toolBrokerService').callTool({
  grantId: grant.grantId,
  agentUserId: String(seat._id),
  agentName: 'alice',
  instanceId: 'default',
  tool: 'github.create_issue',
  args,
});
const park = async (args = ISSUE) => {
  const error = await callIssue(args).then(() => null, (e) => e);
  expect(error).toMatchObject({ code: 'approval_required' });
  return String(error.details.approvalId);
};
const propose = (body) => request(app)
  .post(`/api/agents/runtime/pods/${pod._id}/propose-action`)
  .set('Authorization', `Bearer ${seatToken}`)
  .send(body);
const CREATE_POD = { actionType: 'create_pod', params: { name: 'Side room' }, summary: 'Open a side room for the launch.' };

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  // The guards under test are indexes; a race against an unbuilt index proves nothing.
  await ApprovalAction.init();
  app = express();
  app.use(express.json());
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  human = await User.create({ username: 'atomic-owner', email: 'atomic-owner@test.com', password: 'password123' });
  humanToken = jwt.sign({ id: human._id.toString() }, JWT_SECRET);
  await AgentRegistry.create({
    agentName: 'alice',
    displayName: 'Alice',
    description: 'approval atomic agent',
    registry: 'commonly-official',
    verified: true,
    manifest: {
      name: 'alice',
      version: '1.0.0',
      capabilities: [{ name: 'memory', description: 'memory' }],
      context: { required: ['context:read'] },
      runtime: { type: 'standalone', connection: 'rest' },
    },
    latestVersion: '1.0.0',
    versions: [{ version: '1.0.0', publishedAt: new Date() }],
  });
});

afterAll(closeMongoDb);

beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
  await Promise.all([AgentInstallation.deleteMany({}), Integration.deleteMany({}),
    ApprovalAction.deleteMany({}), RoomGrant.deleteMany({}), Message.deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({
    name: 'Atomic pod', type: 'chat', createdBy: human._id, members: [human._id], 
  });
  seatToken = await installAndIssueToken('alice');
  seat = await User.findOne({ isBot: true, 'botMetadata.agentName': 'alice' });
  expect(seat).toBeTruthy();
  await Integration.create({
    type: 'github-app',
    status: 'connected',
    createdBy: human._id,
    podId: pod._id,
    installationId: 'gh-atomic-1',
    config: { installationId: 'gh-atomic-1', owner: 'Team-Commonly', repo: 'commonly' }, 
  });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  grant = await mintGrant({
    connectionId: 'gh-atomic-1',
    installationId: 'gh-atomic-1',
    target: { kind: 'pod', id: String(pod._id) },
    tools: ['github.create_issue'],
    writeMode: 'write-with-confirm',
    audience: [String(seat._id)],
    expiresAt: new Date(Date.now() + 86400000),
    brokerId: GRANT_BROKER_ID,
    ownerId: String(human._id),
  });
});

const callWith = (args, extra = {}) => require('../../services/toolBrokerService').callTool({
  grantId: grant.grantId,
  agentUserId: String(seat._id),
  agentName: 'alice',
  instanceId: 'default',
  tool: 'github.create_issue',
  args,
  ...extra,
});

/**
 * Hold every caller at the open-card count until `n` have read it, so all of
 * them decide on the same snapshot before any of them creates a row. This is
 * the interleaving the find-then-create and count-then-create guards lose.
 */
const barrierOnOpenCount = (n) => {
  const original = ApprovalAction.countDocuments.bind(ApprovalAction);
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return jest.spyOn(ApprovalAction, 'countDocuments').mockImplementation(async (...args) => {
    const result = await original(...args);
    arrived += 1;
    if (arrived >= n) release();
    if (arrived <= n) await gate;
    return result;
  });
};

describe('atomic reuse (F184 item 1)', () => {
  test('two concurrent identical calls create one approval and both park on it', async () => {
    const spy = barrierOnOpenCount(2);
    let results;
    try {
      results = await Promise.all([callWith(ISSUE), callWith(ISSUE)].map((p) => p.then(() => null, (e) => e)));
    } finally { spy.mockRestore(); }
    expect(await ApprovalAction.countDocuments({})).toBe(1);
    expect(await cards()).toHaveLength(1);
    const [a, b] = results;
    expect(a).toMatchObject({ code: 'approval_required' });
    expect(b).toMatchObject({ code: 'approval_required' });
    expect(String(a.details.approvalId)).toBe(String(b.details.approvalId));
    expect(a.details.callId).toBe(b.details.callId);
  });

  test('an identical call whose card is still posting, in another slot, is waited for and reused', async () => {
    // The open twin holds slot 1 and slot 0 is free: the shape left when the
    // row in slot 0 closes mid-race. Only the identity index stops a second
    // row here, because the slots alone would let this call take slot 0.
    const first = await callWith(ISSUE).then(() => null, (e) => e);
    const twinId = first.details.approvalId;
    const { messageId } = await ApprovalAction.findById(twinId).lean();
    await ApprovalAction.updateOne({ _id: twinId }, { $set: { toolCallSlot: 1 }, $unset: { messageId: 1 } });
    // Its card lands while the second call waits.
    const landed = new Promise((resolve) => {
      setTimeout(() => {
        ApprovalAction.updateOne({ _id: twinId }, { $set: { messageId } }).then(resolve);
      }, 200);
    });
    const second = await callWith(ISSUE).then(() => null, (e) => e);
    await landed;
    expect(await ApprovalAction.countDocuments({})).toBe(1);
    expect(second).toMatchObject({ code: 'approval_required' });
    expect(String(second.details.approvalId)).toBe(String(twinId));
    expect(second.details.callId).toBe(first.details.callId);
  });

  test('a twin whose card never posts sends the call back as retryable, without a second row', async () => {
    const first = await callWith(ISSUE).then(() => null, (e) => e);
    await ApprovalAction.updateOne({ _id: first.details.approvalId }, { $set: { toolCallSlot: 1 }, $unset: { messageId: 1 } });
    const second = await callWith(ISSUE).then(() => null, (e) => e);
    expect(second).toMatchObject({ code: 'approval_unavailable', statusCode: 503 });
    expect(await ApprovalAction.countDocuments({})).toBe(1);
  });
});

describe('a strict cap under concurrency (F184 item 2)', () => {
  test('four concurrent distinct calls at a cap of 3 create exactly 3', async () => {
    const spy = barrierOnOpenCount(4);
    let results;
    try {
      results = await Promise.all([1, 2, 3, 4].map((n) => callWith({ title: `Bug ${n}`, body: 'x' })
        .then(() => null, (e) => e)));
    } finally { spy.mockRestore(); }
    expect(await ApprovalAction.countDocuments({ status: 'flagged' })).toBe(3);
    expect(await ApprovalAction.countDocuments({})).toBe(3);
    expect(await cards()).toHaveLength(3);
    const codes = results.map((e) => e && e.code).sort();
    expect(codes).toEqual(['approval_queue_full', 'approval_required', 'approval_required', 'approval_required']);
  });
});

describe('a cardless row stops holding a slot (F184 item 3)', () => {
  test('the sweeper moots a cardless open row past the grace period, and the slot frees', async () => {
    await [1, 2, 3].reduce((prior, n) => prior.then(() => park({ title: `Bug ${n}`, body: 'x' })), Promise.resolve());
    // A crash between create and post: the row is open and has no card.
    const crashed = await ApprovalAction.findOne({ status: 'flagged' }).sort({ createdAt: 1 });
    await ApprovalAction.updateOne({ _id: crashed._id }, { $unset: { messageId: 1 } });

    const full = await callWith({ title: 'Bug 4', body: 'x' }).then(() => null, (e) => e);
    expect(full).toMatchObject({ code: 'approval_queue_full' });

    // Inside the grace period a cardless row may still be posting its card.
    expect(await sweepCardlessToolCallApprovals(new Date(Date.now() + 60 * 1000))).toBe(0);
    expect((await ApprovalAction.findById(crashed._id).lean()).status).toBe('flagged');

    expect(await sweepCardlessToolCallApprovals(new Date(Date.now() + 10 * 60 * 1000))).toBe(1);
    const mooted = await ApprovalAction.findById(crashed._id).lean();
    expect(mooted.status).toBe('moot');
    expect(mooted.toolCall.canonicalArgs).toBeUndefined();
    // Carded rows are untouched.
    expect(await ApprovalAction.countDocuments({ status: 'flagged' })).toBe(2);

    const parked = await callWith({ title: 'Bug 4', body: 'x' }).then(() => null, (e) => e);
    expect(parked).toMatchObject({ code: 'approval_required' });
    expect(await ApprovalAction.countDocuments({ status: 'flagged' })).toBe(3);
  });
});

describe('a reused approval reports to every run waiting on it (F184 item 4)', () => {
  test('the decision event names both the run that created it and the run that reused it', async () => {
    const firstRun = new mongoose.Types.ObjectId().toString();
    const laterRun = new mongoose.Types.ObjectId().toString();
    const first = await callWith(ISSUE, { runId: firstRun, runPodId: String(pod._id) }).then(() => null, (e) => e);
    const later = await callWith(ISSUE, { runId: laterRun, runPodId: String(pod._id) }).then(() => null, (e) => e);
    expect(String(later.details.approvalId)).toBe(String(first.details.approvalId));

    const approvalId = String(first.details.approvalId);
    expect((await resolveApproval({ approvalId, callerUserId: String(human._id), decision: 'approved' })).status)
      .toBe(200);
    expect(github.createIssue).toHaveBeenCalledTimes(1);
    const resolved = AgentEventService.enqueue.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'approval.resolved' && event.payload.approvalId === approvalId);
    expect(resolved).toHaveLength(1);
    expect([...resolved[0].payload.runIds].sort()).toEqual([firstRun, laterRun].sort());
  });
});
