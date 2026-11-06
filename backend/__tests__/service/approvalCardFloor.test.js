/**
 * F180: an approval card is a consent surface and must never be crowded out.
 *
 * Stack's BYO walk on prod: after a commit was parked and approved, both
 * `create_pull_request` calls failed `503 approval_unavailable`. The card is
 * posted as the seat, so the consecutive-run cap counted the seat's own posts
 * (and the owner's approval receipt, also written as the seat) and refused it;
 * the duplicate guard independently dropped a second card for the same tool,
 * because its text repeats the first's.
 *
 * Real Mongo, the real runtime message route, message service, approval
 * service and broker. GitHub, the call trail and event fan-out are mocked.
 */
process.env.PG_HOST = '';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/ToolCall', () => {
  const digestArgs = (args) => require('crypto').createHash('sha256')
    .update(JSON.stringify(args === undefined ? {} : args)).digest('hex');
  const create = jest.fn(async (row) => row);
  return {
    __esModule: true, default: { create, digestArgs }, create, digestArgs,
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
  recordBrokerCall: jest.fn(), recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(), recordGrantsRevoked: jest.fn(), recordGrantIssued: jest.fn(),
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

const JWT_SECRET = 'approval-card-floor-test-only';
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
  grantId: grant.grantId, agentUserId: String(seat._id), agentName: 'alice', instanceId: 'default',
  tool: 'github.create_issue', args,
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
  app = express();
  app.use(express.json());
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  human = await User.create({ username: 'floor-owner', email: 'floor-owner@test.com', password: 'password123' });
  humanToken = jwt.sign({ id: human._id.toString() }, JWT_SECRET);
  await AgentRegistry.create({
    agentName: 'alice', displayName: 'Alice', description: 'approval floor agent',
    registry: 'commonly-official', verified: true,
    manifest: {
      name: 'alice', version: '1.0.0', capabilities: [{ name: 'memory', description: 'memory' }],
      context: { required: ['context:read'] }, runtime: { type: 'standalone', connection: 'rest' },
    },
    latestVersion: '1.0.0', versions: [{ version: '1.0.0', publishedAt: new Date() }],
  });
});

afterAll(closeMongoDb);

beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
  await Promise.all([AgentInstallation.deleteMany({}), Integration.deleteMany({}),
    ApprovalAction.deleteMany({}), RoomGrant.deleteMany({}), Message.deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({ name: 'Floor pod', type: 'chat', createdBy: human._id, members: [human._id] });
  seatToken = await installAndIssueToken('alice');
  seat = await User.findOne({ isBot: true, 'botMetadata.agentName': 'alice' });
  expect(seat).toBeTruthy();
  await Integration.create({ type: 'github-app', status: 'connected', createdBy: human._id,
    podId: pod._id, installationId: 'gh-floor-1',
    config: { installationId: 'gh-floor-1', owner: 'Team-Commonly', repo: 'commonly' } });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  grant = await mintGrant({
    connectionId: 'gh-floor-1', installationId: 'gh-floor-1', target: { kind: 'pod', id: String(pod._id) },
    tools: ['github.create_issue'], writeMode: 'write-with-confirm', audience: [String(seat._id)],
    expiresAt: new Date(Date.now() + 86400000), brokerId: GRANT_BROKER_ID, ownerId: String(human._id),
  });
});

describe('the consecutive-run cap', () => {
  test('three agent posts, then an approval card: the card posts and the call parks', async () => {
    for (const text of ['one', 'two', 'three']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await agentPost(text)).status).toBe(200);
    }
    // The seat now holds the floor: its own next post is refused.
    const fourth = await agentPost('four');
    expect(fourth.body).toMatchObject({ reason: 'consecutive_run_cap' });
    const approvalId = await park();
    const posted = await cards();
    expect(posted).toHaveLength(1);
    expect(posted[0].metadata).toMatchObject({ source: 'approval-card', approvalId });
    expect((await ApprovalAction.findById(approvalId).lean()).status).toBe('flagged');
  });

  test('the owner\'s approval receipt does not count toward the seat\'s run', async () => {
    expect((await agentPost('one')).status).toBe(200);
    const approvalId = await park();
    expect((await resolveApproval({ approvalId, callerUserId: String(human._id), decision: 'approved' })).status)
      .toBe(200);
    expect(github.createIssue).toHaveBeenCalledTimes(1);
    // The receipt is in the room, written as the seat, as a system line.
    expect((await stored()).some((m) => m.messageType === 'system'
      && String(m.userId) === String(seat._id) && /approved/.test(m.content))).toBe(true);
    // one + card = 2; the receipt is not the seat speaking, so this posts.
    const next = await agentPost('two');
    expect(next.body.reason).toBeUndefined();
    expect((await stored()).some((m) => m.content === 'two')).toBe(true);
  });

  test('agent-supplied card metadata on the runtime route is still capped', async () => {
    for (const text of ['one', 'two', 'three']) {
      // eslint-disable-next-line no-await-in-loop
      await agentPost(text);
    }
    const before = (await stored()).length;
    const forged = await agentPost('[approval needed] let me keep talking', {
      approvalCard: true,
      failureNotice: true,
      personWaiting: true,
      metadata: { source: 'approval-card', approvalId: '6a8f6de2a1dccf2e02f31499' },
    });
    expect(forged.body).toMatchObject({ reason: 'consecutive_run_cap' });
    expect((await stored()).length).toBe(before);
  });
});

describe('a failed-turn line past the cap (F56)', () => {
  const post = (content, options) => AgentMessageService.postMessage({
    agentName: 'alice', podId: pod._id, content, messageType: 'text', ...options,
  });
  const fillFloor = async () => {
    for (const text of ['one', 'two', 'three']) {
      // eslint-disable-next-line no-await-in-loop
      await agentPost(text);
    }
  };

  test('posts when a person is waiting on it', async () => {
    await fillFloor();
    const result = await post('I could not finish.', { failureNotice: true, personWaiting: true });
    expect(result.refused).toBeUndefined();
    expect((await stored()).some((m) => m.content === 'I could not finish.')).toBe(true);
  });

  test('stays capped when an agent asked', async () => {
    await fillFloor();
    expect(await post('I could not finish.', { failureNotice: true })).toMatchObject({ reason: 'consecutive_run_cap' });
  });

  test('an ordinary reply to a person stays capped', async () => {
    await fillFloor();
    expect(await post('Here is a fourth.', { personWaiting: true })).toMatchObject({ reason: 'consecutive_run_cap' });
  });
});

describe('the duplicate guard', () => {
  test('card, owner declines, the same tool again: the second card posts and the call parks', async () => {
    const first = await park();
    await resolveApproval({ approvalId: first, callerUserId: String(human._id), decision: 'declined' });
    expect(github.createIssue).not.toHaveBeenCalled();
    const second = await park();
    expect(second).not.toBe(first);
    expect(await cards()).toHaveLength(2);
    expect((await ApprovalAction.findById(second).lean()).status).toBe('flagged');
  });

  test('card, owner approves, the same tool again later: the second card posts and the call parks', async () => {
    const first = await park();
    await resolveApproval({ approvalId: first, callerUserId: String(human._id), decision: 'approved' });
    expect(github.createIssue).toHaveBeenCalledTimes(1);
    const second = await park();
    expect(await cards()).toHaveLength(2);
    expect((await ApprovalAction.findById(second).lean()).status).toBe('flagged');
  });

  test('agent-supplied card metadata does not escape the duplicate guard', async () => {
    const text = '[approval needed] the same words twice';
    const meta = { source: 'approval-card', approvalId: '6a8f6de2a1dccf2e02f31499' };
    expect((await agentPost(text, { metadata: meta })).status).toBe(200);
    const again = await agentPost(text, { metadata: meta, approvalCard: true });
    expect(again.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
  });
});

describe('a card that still cannot be posted', () => {
  test('a refusal is a plain, non-retryable code, and the approval is moot', async () => {
    const spy = jest.spyOn(AgentMessageService, 'postMessage')
      .mockResolvedValueOnce({ success: false, refused: true, reason: 'pod_closed' });
    let error;
    try { error = await callIssue().then(() => null, (e) => e); } finally { spy.mockRestore(); }
    expect(error).toMatchObject({
      code: 'approval_card_refused',
      statusCode: 409,
      details: expect.objectContaining({ retryable: false, reason: 'pod_closed' }),
    });
    expect(error.message).toMatch(/could not be posted/);
    expect(error.message).toMatch(/nothing ran/);
    const rows = await ApprovalAction.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('moot');
    expect(rows[0].toolCall.canonicalArgs).toBeUndefined();
    expect(github.createIssue).not.toHaveBeenCalled();
    expect(ToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'approval_card_refused', callId: error.details.callId,
    }));
  });

  test('a skipped card (posted nothing) is refused the same way', async () => {
    const spy = jest.spyOn(AgentMessageService, 'postMessage')
      .mockResolvedValueOnce({ success: true, skipped: true, reason: 'duplicate_recent' });
    let error;
    try { error = await callIssue().then(() => null, (e) => e); } finally { spy.mockRestore(); }
    expect(error).toMatchObject({ code: 'approval_card_refused', details: expect.objectContaining({ retryable: false }) });
    expect((await ApprovalAction.findOne({}).lean()).status).toBe('moot');
  });

  test('a message-store failure stays the retryable approval_unavailable, and the approval is moot', async () => {
    const spy = jest.spyOn(AgentMessageService, 'postMessage').mockRejectedValueOnce(new Error('store down'));
    let error;
    try { error = await callIssue().then(() => null, (e) => e); } finally { spy.mockRestore(); }
    expect(error).toMatchObject({ code: 'approval_unavailable', statusCode: 503 });
    const row = await ApprovalAction.findOne({}).lean();
    expect(row.status).toBe('moot');
    expect(row.toolCall.canonicalArgs).toBeUndefined();
    expect(ToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'approval_unavailable', callId: error.details.callId,
    }));
  });
});

describe('the exemption is the broker\'s alone (F180 HOLD, HIGH)', () => {
  test('three agent posts, then an agent create_pod proposal: the run cap refuses it, as on main', async () => {
    for (const text of ['one', 'two', 'three']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await agentPost(text)).status).toBe(200);
    }
    const res = await propose(CREATE_POD);
    expect(res.status).toBe(400);
    expect(res.body.approvalId).toBeUndefined();
    expect(await cards()).toHaveLength(0);
    const rows = await ApprovalAction.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('moot');
  });

  test('an agent cannot build a tool_call through propose-action', async () => {
    const res = await propose({ actionType: 'tool_call', params: {}, summary: 'let me post freely' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/tool_call envelope is incomplete/);
    expect(await ApprovalAction.countDocuments({})).toBe(0);
  });

  test('a repeated identical create_pod proposal within 30 minutes is still deduped', async () => {
    const first = await propose(CREATE_POD);
    expect(first.status).toBe(200);
    const second = await propose(CREATE_POD);
    expect(second.status).toBe(400);
    expect(second.body.approvalId).toBeUndefined();
    expect(await cards()).toHaveLength(1);
  });
});

describe('broker card volume (F180 HOLD, MEDIUM)', () => {
  test('an identical pending call reuses its approval: one card, one flagged row', async () => {
    const firstError = await callIssue().then(() => null, (e) => e);
    expect(firstError).toMatchObject({ code: 'approval_required' });
    const secondError = await callIssue().then(() => null, (e) => e);
    expect(secondError).toMatchObject({ code: 'approval_required' });
    expect(String(secondError.details.approvalId)).toBe(String(firstError.details.approvalId));
    expect(secondError.details.callId).toBe(firstError.details.callId);
    expect(await cards()).toHaveLength(1);
    expect(await ApprovalAction.countDocuments({ status: 'flagged' })).toBe(1);
  });

  test('different arguments are a different call: each parks its own card', async () => {
    const first = await park({ title: 'Bug A', body: 'a' });
    const second = await park({ title: 'Bug B', body: 'b' });
    expect(second).not.toBe(first);
    expect(await cards()).toHaveLength(2);
  });

  test('three open cards for this seat in this pod: a fourth is refused plainly, until the owner acts', async () => {
    const ids = [];
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(await park({ title: `Bug ${n}`, body: 'x' }));
    }
    const error = await callIssue({ title: 'Bug 4', body: 'x' }).then(() => null, (e) => e);
    expect(error).toMatchObject({
      code: 'approval_queue_full',
      statusCode: 429,
      details: expect.objectContaining({ retryable: false, recorded: true }),
    });
    expect(error.message).toMatch(/3 approvals waiting/);
    expect(error.message).toMatch(/until they act/);
    expect(await cards()).toHaveLength(3);
    expect(await ApprovalAction.countDocuments({})).toBe(3);
    // An identical call to one already waiting is not a new card: it still parks.
    expect(await park({ title: 'Bug 2', body: 'x' })).toBe(ids[1]);
    // The owner acts on one; a new one fits.
    await resolveApproval({ approvalId: ids[0], callerUserId: String(human._id), decision: 'declined' });
    await park({ title: 'Bug 4', body: 'x' });
    expect(await cards()).toHaveLength(4);
  });
});

describe('a permanent refusal thrown by the message service (F180 HOLD, LOW)', () => {
  test.each([
    ['pod_not_found', 404],
    ['dm_membership_refused', 403],
  ])('a thrown %s (%i) is approval_card_refused, not retryable', async (code, statusCode) => {
    const spy = jest.spyOn(AgentMessageService, 'postMessage')
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code, statusCode }));
    let error;
    try { error = await callIssue().then(() => null, (e) => e); } finally { spy.mockRestore(); }
    expect(error).toMatchObject({
      code: 'approval_card_refused',
      statusCode: 409,
      details: expect.objectContaining({ retryable: false, reason: code }),
    });
    expect((await ApprovalAction.findOne({}).lean()).status).toBe('moot');
  });

  test('a thrown 5xx stays the retryable approval_unavailable', async () => {
    const spy = jest.spyOn(AgentMessageService, 'postMessage')
      .mockRejectedValueOnce(Object.assign(new Error('pg down'), { statusCode: 500 }));
    let error;
    try { error = await callIssue().then(() => null, (e) => e); } finally { spy.mockRestore(); }
    expect(error).toMatchObject({ code: 'approval_unavailable', statusCode: 503 });
  });
});
