const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn(async () => ({
  success: true, message: { id: String(new (require('mongoose').Types.ObjectId)()) },
})) }));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/attentionItemService', () => ({ recordActionApproval: jest.fn(), resolve: jest.fn() }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const Approval = require('../../models/ApprovalAction');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { createOffPlaybook, setPlaybookOn } = require('../../services/playbooks/store');
const { startPlaybookRun } = require('../../services/playbooks/runState');
const { completeTaskWithRevision } = require('../../services/taskMutationService');
const { describePlaybookPoint, applyPlaybookRuling } = require('../../services/playbooks/rulings');
const { proposeAction, resolveApproval } = require('../../services/approvalActionService');
let person; let agent; let outsider; let pod; let point; let root;
const previousFlag = process.env.PLAYBOOKS_ENABLED;
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); process.env.PLAYBOOKS_ENABLED = 'true';
  person = await User.create({ username: 'sender', email: 'sender@example.test', password: 'test-password' });
  outsider = await User.create({ username: 'outsider', email: 'outsider@example.test', password: 'test-password' });
  agent = await User.create({ username: 'checker', email: 'checker@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'checker' } });
  pod = await Pod.create({ name: 'Workflow', members: [person._id, agent._id], createdBy: outsider._id });
  await AgentInstallation.create({ agentName: 'codex', instanceId: 'checker', podId: pod._id, version: '1',
    installedBy: outsider._id, config: { runtime: { runtimeType: 'webhook' } } });
});
afterEach(() => { if (previousFlag === undefined) delete process.env.PLAYBOOKS_ENABLED;
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
});
test('decline blocks the row/run and cannot be resumed through completion', async () => {
  await start(); const proposed = await propose();
  expect((await decide(proposed.approvalId, 'declined')).status).toBe(200);
  expect((await Task.findById(point._id)).ruling.state).toBe('declined');
  expect((await Task.findById(root._id)).status).toBe('blocked');
  expect(await complete(point, person)).toBeNull();
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
  const oldCard = await Approval.findById(first.approvalId);
  const { askAgainForPlaybookPoint } = require('../../services/playbooks/runner');
  const renewed = await askAgainForPlaybookPoint(String(pod._id), point.taskId, String(person._id));
  expect(String(renewed.ruling.approvalId)).not.toBe(first.approvalId);
  expect((await applyPlaybookRuling(oldCard)).applied).toBe(false);
  expect((await Task.findById(point._id)).ruling.state).toBe('awaiting');
  expect((await decide(String(renewed.ruling.approvalId), 'approved')).status).toBe(200);
  await complete(renewed, person);
  expect((await Task.findById(root._id)).status).toBe('done');
});
