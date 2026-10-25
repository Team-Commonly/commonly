const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn(async () => ({
  success: true, message: { id: String(new (require('mongoose').Types.ObjectId)()) },
})) }));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/needsYouEmailService', () => ({ sendNeedsYouEmail: jest.fn() }));
jest.mock('../../services/objectStore', () => ({ getObjectStore: () => ({ get: jest.fn().mockResolvedValue(null) }) }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const File = require('../../models/File');
const Approval = require('../../models/ApprovalAction');
const Installation = require('../../models/InstallableInstallation');
const Installable = require('../../models/Installable');
const PodAsset = require('../../models/PodAsset');
const Task = require('../../models/Task');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentity = require('../../services/agentIdentityService');
const { dispatchTool, toolsForConfig } = require('../../services/nativeRuntimeService');
const { proposeAction, resolveApproval } = require('../../services/approvalActionService');
const { playbookOptions } = require('../../services/playbooks/store');
let human; let bot; let other; let pod; let context;
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  human = await User.create({ username: 'editor', email: 'editor@example.test', password: 'test-password' });
  other = await User.create({ username: 'other', email: 'other@example.test', password: 'test-password' });
  const username = AgentIdentity.buildAgentUsername(AgentIdentity.resolveAgentType('scout'), 'default');
  bot = await User.create({ username, email: 'scout@example.test', password: 'test-password', isBot: true,
    botType: 'agent', botMetadata: { agentName: 'scout', instanceId: 'default' } });
  pod = await Pod.create({ name: 'Team', createdBy: other._id, members: [human._id, bot._id] });
  await AgentInstallation.create({ agentName: 'scout', instanceId: 'default', podId: pod._id, version: '1',
    installedBy: human._id, config: { runtime: { runtimeType: 'native' } } });
  context = { podId: String(pod._id), agentName: 'scout', instanceId: 'default' };
});
const draft = () => ({ title: 'Outreach reply', sourceText: 'Our procedure', definition: { v: 1,
  roles: [{ key: 'drafter', kind: 'agent' }, { key: 'sender', kind: 'person' }], steps: [
    { key: 'draft', title: 'Draft', role: 'drafter', do: 'Draft a reply', delivers: 'post' },
    { key: 'send', title: 'Send manually', role: 'sender', do: 'Approve and manually send', writeGap: 'LinkedIn',
      approval: { by: 'sender', act: 'actor', effect: 'none' } },
  ], done: [{ says: 'Approved', check: 'approved', step: 'send' },
    { says: 'Manual send complete', check: 'done', step: 'send' },
    { says: 'Sent by person', check: 'by-person', step: 'send' }],
} });
const propose = (params = draft()) => proposeAction({ ...context, actionType: 'create_playbook', params,
  summary: 'Save an outreach workflow draft, Off' });
const decide = (approvalId, decision = 'approved', who = human) => resolveApproval({ approvalId,
  decision, callerUserId: String(who._id) });
const upload = (name, type, text, podId = pod._id) => File.create({ fileName: name, originalName: name,
  contentType: type, size: Buffer.byteLength(text), data: Buffer.from(text), podId, uploadedBy: human._id });

test('Scout explicitly opts in to file/options and receives current options without a write', async () => {
  const { scoutApp } = require('../../config/native-agents/scout');
  const names = toolsForConfig(scoutApp).map((tool) => tool.function.name);
  expect(names).toEqual(expect.arrayContaining(['commonly_read_file', 'commonly_playbook_options']));
  expect(toolsForConfig(null).map((tool) => tool.function.name)).not.toEqual(expect.arrayContaining(['commonly_read_file']));
  const result = await dispatchTool('commonly_playbook_options', {}, context);
  expect(result.error).toBeUndefined();
  expect(result.content).toMatchObject({ triggers: ['run', 'schedule'], supportedEffects: ['none'] });
  expect(result.content.members).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: String(human._id), kind: 'person' }),
    expect.objectContaining({ userId: String(bot._id), kind: 'agent', runtime: 'native' }),
  ]));
  expect(await Installation.countDocuments()).toBe(0);
  expect(await Task.countDocuments()).toBe(0);
});
test('native file tool reads the same text-only pod reader, without persisting attachment text in its trace', async () => {
  await upload('procedure.md', 'text/markdown', '# Outreach\nDraft then send manually');
  const read = await dispatchTool('commonly_read_file', { fileName: 'procedure.md' }, context);
  expect(read.content.content).toBe('# Outreach\nDraft then send manually');
  expect(read.untrustedSourceTitle).toBe('a pod attachment');
  expect(read.recorded).toEqual({ fileName: 'procedure.md', contentType: 'text/markdown', size: 35 });
  expect(JSON.stringify(read.recorded)).not.toContain('Draft then send');
  await upload('large.md', 'text/markdown', 'x'.repeat(256 * 1024 + 1));
  const large = await dispatchTool('commonly_read_file', { fileName: 'large.md' }, context);
  expect(large.content.content).toBeNull(); expect(large.content.note).toMatch(/limit/);
});
test.each(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])(
  '%s never supplies binary bytes as document text', async (type) => {
    await upload('document.bin', type, 'PK\u0003\u0004privatebytes');
    const result = await dispatchTool('commonly_read_file', { fileName: 'document.bin' }, context);
    expect(result.content.content).toBeNull(); expect(result.content.note).toMatch(/Binary/);
    expect(JSON.stringify(result)).not.toContain('privatebytes');
  });
test('file/options calls recheck membership and never accept a guessed file from another pod', async () => {
  await upload('elsewhere.md', 'text/plain', 'private', new mongoose.Types.ObjectId());
  expect((await dispatchTool('commonly_read_file', { fileName: 'elsewhere.md' }, context)).error).toBeTruthy();
  expect((await dispatchTool('commonly_read_file', { fileName: '../procedure.md' }, context)).error).toBeTruthy();
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: bot._id } });
  for (const tool of ['commonly_read_file', 'commonly_playbook_options']) {
    expect((await dispatchTool(tool, { fileName: 'elsewhere.md' }, context)).error).toBe('pod_membership_required');
  }
  await expect(playbookOptions(String(pod._id), String(bot._id))).rejects.toMatchObject({ code: 'pod_membership_required' });
});
test('a same-named legacy file in another pod cannot supply the selected file’s bytes', async () => {
  await upload('shared-name.md', 'text/plain', 'foreign bytes', new mongoose.Types.ObjectId());
  await upload('shared-name.md', 'text/plain', 'this pod bytes');
  expect((await dispatchTool('commonly_read_file', { fileName: 'shared-name.md' }, context)).content.content)
    .toBe('this pod bytes');
});
test('a non-admin approves a validated proposal into an Off installation and source skill; approval does not run it', async () => {
  const params = draft(); params.sourceText = 'x'.repeat(9000);
  const proposed = await propose(params); expect(proposed.ok).toBe(true);
  expect(await Installation.countDocuments()).toBe(0);
  expect(await Task.countDocuments()).toBe(0);
  expect((await decide(proposed.approvalId, 'approved', other)).status).toBe(403);
  expect((await decide(proposed.approvalId, 'approved', bot)).status).toBe(403);
  const resolved = await decide(proposed.approvalId); expect(resolved.status).toBe(200);
  const card = await Approval.findById(proposed.approvalId);
  expect(card.executionError).toBeUndefined();
  expect(card.executionResult.on).toBe(false);
  expect((await Installation.findOne()).status).toBe('paused');
  expect((await Installable.findOne()).components[0].metadata.playbook).toEqual(params.definition);
  expect((await PodAsset.findOne()).content).toHaveLength(8000);
  expect(await Task.countDocuments()).toBe(0);
  await decide(proposed.approvalId);
  expect(await Installation.countDocuments()).toBe(1);
});
test.each([
  ['ungranted tool', (d) => { d.definition.steps[0].reads = ['private.vendor.read']; }],
  ['future effect', (d) => { d.definition.steps[1].approval.effect = 'connector'; }],
  ['unknown role', (d) => { d.definition.steps[0].role = 'stranger'; }],
  ['arbitrary cron', (d) => { d.schedule = { cron: '* * * * *', timezone: 'UTC' }; }],
  ['unknown field', (d) => { d.on = true; }],
])('%s is refused before creating a card', async (_, mutate) => {
  const params = draft(); mutate(params);
  expect((await propose(params)).ok).toBe(false);
  expect(await Approval.countDocuments()).toBe(0); expect(await Installation.countDocuments()).toBe(0);
});
test('declining a Scout proposal never installs it', async () => {
  const proposed = await propose(); await decide(proposed.approvalId, 'declined');
  expect(await Installation.countDocuments()).toBe(0); expect(await PodAsset.countDocuments()).toBe(0);
});
test.each(['human', 'agent'])('Approve rechecks the %s membership before creating anything', async (kind) => {
  const proposed = await propose();
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: kind === 'human' ? human._id : bot._id } });
  await decide(proposed.approvalId);
  const card = await Approval.findById(proposed.approvalId);
  expect(card.executionError).toBeTruthy();
  expect(await Installation.countDocuments()).toBe(0); expect(await PodAsset.countDocuments()).toBe(0);
});
test('a target pod requires the proposer and an accountable current human member', async () => {
  const target = await Pod.create({ name: 'Other team', createdBy: other._id, members: [other._id] });
  expect((await propose({ ...draft(), podId: String(target._id) })).ok).toBe(false);
  await Pod.updateOne({ _id: target._id }, { $addToSet: { members: bot._id } });
  const result = await propose({ ...draft(), podId: String(target._id) });
  expect(result.ok).toBe(true);
  expect(String((await Approval.findById(result.approvalId)).ownerUserId)).toBe(String(other._id));
  await decide(result.approvalId, 'approved', other);
  expect(String((await Installation.findOne()).targetId)).toBe(String(target._id));
});
