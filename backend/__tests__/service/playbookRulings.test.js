const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn(async () => ({
  success: true, message: { id: String(new (require('mongoose').Types.ObjectId)()) },
})) }));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/needsYouEmailService', () => ({ sendNeedsYouEmail: jest.fn() }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const Approval = require('../../models/ApprovalAction');
const AttentionItem = require('../../models/AttentionItem');
const { bindSocketIO } = require('../../services/taskEventService');
const { publishPlaybookTask, blockPlaybookRun } = require('../../services/playbooks/observations');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { createOffPlaybook, setPlaybookOn } = require('../../services/playbooks/store');
const { startPlaybookRun } = require('../../services/playbooks/runState');
const { completeTaskWithRevision } = require('../../services/taskMutationService');
const { describePlaybookPoint, applyPlaybookRuling } = require('../../services/playbooks/rulings');
const { proposeAction, resolveApproval } = require('../../services/approvalActionService');
let person; let agent; let outsider; let pod; let point; let root; let socketEvents;
const previousFlag = process.env.PLAYBOOKS_ENABLED;
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); process.env.PLAYBOOKS_ENABLED = 'true';
  socketEvents = [];
  bindSocketIO({ to: (room) => ({ emit: (event, payload) => socketEvents.push({ room, event, payload }) }) });
  person = await User.create({ username: 'sender', email: 'sender@example.test', password: 'test-password' });
  outsider = await User.create({ username: 'outsider', email: 'outsider@example.test', password: 'test-password' });
  agent = await User.create({ username: 'checker', email: 'checker@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'checker' } });
  pod = await Pod.create({ name: 'Workflow', members: [person._id, agent._id], createdBy: outsider._id });
  await AgentInstallation.create({ agentName: 'codex', instanceId: 'checker', podId: pod._id, version: '1',
    installedBy: outsider._id, config: { runtime: { runtimeType: 'webhook' } } });
});
afterEach(() => { bindSocketIO(null); if (previousFlag === undefined) delete process.env.PLAYBOOKS_ENABLED;
  else process.env.PLAYBOOKS_ENABLED = previousFlag; });
const actor = (user) => ({ userId: String(user._id), assignee: user.username, isBot: user.isBot });
const complete = (row, user) => completeTaskWithRevision({ podId: pod._id, taskId: row.taskId, status: { $ne: 'done' } },
  { $set: { status: 'done' } }, actor(user));
const start = async (act = 'actor') => {
  const definition = { v: 1, roles: [{ key: 'checker', kind: 'agent' }, { key: 'sender', kind: 'person' }], steps: [
    { key: 'check', title: 'Check', role: 'checker', do: 'Check the draft' },
    { key: 'send', title: 'Send', role: 'sender', do: 'Approve then send by hand',
      ...(act === 'actor' ? { writeGap: 'linkedin' } : {}), approval: { by: 'sender', act, effect: 'none' } },
  ], done: [{ says: 'Approved', step: 'send', check: 'approved' },
    { says: 'Done', step: 'send', check: 'done' },
    ...(act === 'actor' ? [{ says: 'Sent by a person', step: 'send', check: 'by-person' }] : [])] };
  const installation = await createOffPlaybook(String(pod._id), String(person._id), { title: 'Outreach', definition });
  await setPlaybookOn(String(pod._id), String(person._id), String(installation._id),
    { checker: String(agent._id), sender: String(person._id) }, true);
  const result = await startPlaybookRun({ podId: String(pod._id), installationId: String(installation._id),
    userId: String(person._id), triggerKey: `manual:${randomUUID()}`, input: 'Draft', label: 'Runs when someone presses Run' });
  root = result.run; await complete(result.step, agent);
  point = await Task.findOne({ parentTask: root.taskId, 'ruling.state': 'awaiting' });
};
const propose = () => proposeAction({ podId: String(pod._id), agentName: 'codex', instanceId: 'checker',
  actionType: 'playbook_step', reservedApprovalId: String(point.ruling.approvalId), ownerUserId: String(outsider._id),
  params: { taskId: point.taskId, effect: 'connector' }, summary: 'Approve send' });
const decide = (id, decision, who = person) => resolveApproval({ approvalId: id, callerUserId: String(who._id), decision });

test('D8 approval unlocks only; the bound person must separately attest manual completion', async () => {
  await start();
  expect(await complete(point, person)).toBeNull();
  const proposed = await propose(); expect(proposed.ok).toBe(true);
  const card = await Approval.findById(proposed.approvalId);
  expect(String(card.ownerUserId)).toBe(String(person._id));
  expect(card.params.effect).toBe('none');
  expect((await decide(proposed.approvalId, 'approved', outsider)).status).toBe(403);
  expect((await decide(proposed.approvalId, 'approved', agent)).status).toBe(403);
  expect((await decide(proposed.approvalId, 'approved')).status).toBe(200);
  const approved = await Task.findById(point._id);
  expect(approved.status).toBe('pending'); expect(approved.completedBy).toBeUndefined();
  expect((await Task.findById(root._id)).status).toBe('claimed');
  expect(await complete(approved, agent)).toBeNull();
  expect(await complete(approved, outsider)).toBeNull();
  await complete(approved, person);
  expect((await Task.findById(root._id)).status).toBe('done');
  expect(socketEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ room: `pod_${pod._id}`, event: 'task_updated',
      payload: expect.objectContaining({ kind: 'created', task: expect.objectContaining({ taskId: root.taskId }) }) }),
    expect.objectContaining({ payload: expect.objectContaining({ kind: 'updated',
      task: expect.objectContaining({ taskId: root.taskId, status: 'done' }) }) }),
  ]));
});
test('decline blocks the row/run and cannot be resumed through completion', async () => {
  await start(); const proposed = await propose();
  // The creator is also a current member, but the On owner alone needs this ask.
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: outsider._id } });
  expect((await decide(proposed.approvalId, 'declined')).status).toBe(200);
  expect((await Task.findById(point._id)).ruling.state).toBe('declined');
  expect((await Task.findById(root._id)).status).toBe('blocked');
  expect(await complete(point, person)).toBeNull();
  const blocked = await Task.findById(root._id);
  await publishPlaybookTask(blocked); // repair/repeated sweeps reuse the stored update identity
  await blockPlaybookRun(String(pod._id), root.taskId, 'Same refusal on another sweep');
  const asks = await AttentionItem.find({ 'source.type': 'task', status: 'open' });
  expect(asks).toHaveLength(1);
  expect(String(asks[0].recipientUserId)).toBe(String(person._id));
  expect(asks[0].detail).toBe('Approval declined: Send');
  expect((await Task.findById(root._id)).updates).toHaveLength(blocked.updates.length);
});
test('a departed run owner never falls back to notifying another human member', async () => {
  await start();
  await Pod.updateOne({ _id: pod._id }, { $set: { members: [outsider._id, agent._id] } });
  await blockPlaybookRun(String(pod._id), root.taskId, 'Owner left the pod');
  expect(await AttentionItem.countDocuments({ 'source.type': 'task' })).toBe(0);
});
test('kernel none approval and row completion are one write and recover through the same ruling', async () => {
  await start('kernel'); const proposed = await propose();
  expect((await decide(proposed.approvalId, 'approved')).status).toBe(200);
  const applied = await Task.findById(point._id);
  expect(applied.status).toBe('done'); expect(applied.ruling.state).toBe('approved');
  expect(applied.completedBy).toBeUndefined();
  expect((await Task.findById(root._id)).status).toBe('done');
});
test('agents cannot manufacture playbook cards through the ordinary proposal surface', async () => {
  await start();
  const described = await describePlaybookPoint(String(pod._id), point.taskId, String(point.ruling.approvalId));
  expect(described.agent.userId).toBe(String(agent._id));
  const count = await Approval.countDocuments();
  const refused = await proposeAction({ podId: String(pod._id), agentName: 'codex', instanceId: 'checker',
    actionType: 'playbook_step', params: { taskId: point.taskId }, summary: 'Fake' });
  expect(refused.ok).toBe(false); expect(await Approval.countDocuments()).toBe(count);
});
test('a resolved card saved before a crash can be applied once without another decision', async () => {
  await start(); const proposed = await propose();
  const card = await Approval.findByIdAndUpdate(proposed.approvalId, { $set: { status: 'resolved', decision: 'approved',
    resolvedBy: person._id, resolvedAt: new Date() } }, { new: true });
  expect((await applyPlaybookRuling(card)).applied).toBe(true);
  const before = (await Task.findById(point._id)).toObject();
  expect((await applyPlaybookRuling(card)).applied).toBe(false);
  expect((await Task.findById(point._id)).toObject()).toEqual(before);
});

test('recovery finishes an approved kernel row left pending without a second card', async () => {
  await start('kernel');
  await Task.updateOne({ _id: point._id }, { $set: { 'ruling.state': 'approved',
    'ruling.decidedBy': person._id, 'ruling.decidedAt': new Date() } });
  const { advancePlaybookRun } = require('../../services/playbooks/runState');
  await advancePlaybookRun(String(pod._id), root.taskId);
  expect((await Task.findById(point._id)).status).toBe('done');
  expect((await Task.findById(root._id)).status).toBe('done');
  expect(await Approval.countDocuments()).toBe(1);
});

test('Ask again replaces the card id and rejects a late application of the old decline', async () => {
  await start(); const first = await propose();
  await decide(first.approvalId, 'declined');
  expect(await AttentionItem.countDocuments({ 'source.type': 'task', status: 'open' })).toBe(1);
  const oldCard = await Approval.findById(first.approvalId);
  const { askAgainForPlaybookPoint } = require('../../services/playbooks/runner');
  const renewed = await askAgainForPlaybookPoint(String(pod._id), point.taskId, String(person._id));
  expect(await AttentionItem.countDocuments({ 'source.type': 'task', status: 'open' })).toBe(0);
  expect(String(renewed.ruling.approvalId)).not.toBe(first.approvalId);
  expect((await applyPlaybookRuling(oldCard)).applied).toBe(false);
  expect((await Task.findById(point._id)).ruling.state).toBe('awaiting');
  expect((await decide(String(renewed.ruling.approvalId), 'approved')).status).toBe(200);
  await complete(renewed, person);
  expect((await Task.findById(root._id)).status).toBe('done');
});

test('approval context links the preceding actor’s stored post, and refuses foreign pod/author receipts', async () => {
  await start();
  const Message = require('../../models/Message');
  const prior = await Task.findOne({ podId: pod._id, sourceRef: `${root.sourceRef}:1` });
  const postId = new mongoose.Types.ObjectId();
  await Message.collection.insertOne({ _id: postId, podId: pod._id, userId: agent._id,
    content: 'Checked reply: our response is ready.', createdAt: new Date() });
  await Task.updateOne({ _id: prior._id }, { $set: { completedAt: new Date() },
    $push: { updates: { author: 'playbook', text: `Native result posted: ${postId}`, createdAt: new Date() } } });
  const describe = () => describePlaybookPoint(String(pod._id), point.taskId, String(point.ruling.approvalId));
  const card = await describe();
  expect(card.params.output).toEqual({ taskId: prior.taskId, kind: 'post',
    url: `/v2/pods/${pod._id}#message-${postId}`, excerpt: 'Checked reply: our response is ready.' });
  await Task.updateOne({ _id: prior._id }, {
    $set: { notes: `Checked result: https://commonly.me/v2/pods/${pod._id}#message-${postId}` },
    $pull: { updates: { text: { $regex: '^Native result posted: ' } } },
  });
  expect((await describe()).params.output).toEqual(card.params.output);
  await Message.collection.updateOne({ _id: postId }, { $set: { podId: new mongoose.Types.ObjectId() } });
  expect((await describe()).params.output.kind).toBe('notes');
  await Message.collection.updateOne({ _id: postId }, { $set: { podId: pod._id, userId: person._id } });
  expect((await describe()).params.output.kind).toBe('notes');
  await Task.updateOne({ _id: prior._id }, { $set: { prUrl: 'https://github.com/Team-Commonly/commonly/pull/1' } });
  expect((await describe()).params.output).toMatchObject({ kind: 'pr',
    url: 'https://github.com/Team-Commonly/commonly/pull/1' });
  await Task.updateOne({ _id: prior._id }, { $set: { prUrl: 'javascript:alert(1)' } });
  expect((await describe()).params.output.kind).toBe('notes');
});
