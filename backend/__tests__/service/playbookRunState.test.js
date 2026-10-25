const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const { createOffPlaybook, setPlaybookOn } = require('../../services/playbooks/store');
const { startPlaybookRun, advancePlaybookRun } = require('../../services/playbooks/runState');
const { completeTaskWithRevision } = require('../../services/taskMutationService');
let user; let pod; let installation; let options; const flag = process.env.PLAYBOOKS_ENABLED;
const definition = { v: 1, roles: [{ key: 'owner', kind: 'person' }], steps: [
  { key: 'one', title: 'First', role: 'owner', do: 'First manual action' },
  { key: 'two', title: 'Second', role: 'owner', do: 'Second manual action' },
], done: [{ says: 'Second complete', step: 'two', check: 'by-person' }] };
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); process.env.PLAYBOOKS_ENABLED = 'true';
  user = await User.create({ username: 'owner', email: 'owner@example.test', password: 'test-password' });
  pod = await Pod.create({ name: 'Workflow', members: [user._id], createdBy: user._id });
  installation = await createOffPlaybook(String(pod._id), String(user._id), { title: 'Two steps', definition });
  await setPlaybookOn(String(pod._id), String(user._id), String(installation._id), { owner: String(user._id) }, true);
  options = { podId: String(pod._id), installationId: String(installation._id), userId: String(user._id),
    triggerKey: `manual:${randomUUID()}`, input: 'Work input', label: 'Runs when someone presses Run' };
});
afterEach(async () => {
  await Task.collection.dropIndex('playbook_test_legacy_ref').catch((err) => { if (err.code !== 27) throw err; });
  if (flag === undefined) delete process.env.PLAYBOOKS_ENABLED; else process.env.PLAYBOOKS_ENABLED = flag;
});
const complete = (task) => completeTaskWithRevision({ podId: pod._id, taskId: task.taskId, status: { $ne: 'done' } },
  { $set: { status: 'done', completedAt: new Date() } }, { userId: String(user._id), isBot: false, assignee: 'owner' });

test.each([false, true])('duplicate trigger and advancement converge under legacy=%s indexes', async (legacy) => {
  if (legacy) await Task.collection.createIndex({ podId: 1, sourceRef: 1 }, { unique: true,
    partialFilterExpression: { sourceRef: { $type: 'string' } }, name: 'playbook_test_legacy_ref' });
  options.installationId = options.installationId.toUpperCase();
  const fired = await Promise.allSettled([startPlaybookRun(options), startPlaybookRun(options)]);
  const accepted = fired.filter((r) => r.status === 'fulfilled');
  expect(accepted.length).toBeGreaterThan(0);
  expect(await Task.countDocuments({ parentTask: null })).toBe(1);
  expect(await Task.countDocuments({ parentTask: { $ne: null } })).toBe(1);
  const { run, step } = accepted[0].value;
  expect(run.sourceRef).toContain(`playbook:${String(installation._id)}:`);
  const replay = await startPlaybookRun(options);
  expect(String(replay.run._id)).toBe(String(run._id));
  await complete(step);
  await Promise.all([advancePlaybookRun(String(pod._id), step.taskId), advancePlaybookRun(String(pod._id), step.taskId)]);
  const steps = await Task.find({ parentTask: run.taskId }).sort({ taskNum: 1 });
  expect(steps).toHaveLength(2);
  expect(steps[1].status).toBe('pending');
  await complete(steps[1]);
  const finished = await Task.findById(run._id).lean();
  expect(finished.status).toBe('done');
  expect(finished.updates.at(-1).text).toBe('Done check passed');
  const after = await startPlaybookRun(options);
  expect(after.step).toBeNull();
  expect(await Task.findById(run._id).lean()).toEqual(finished);
  expect(await Task.countDocuments()).toBe(3);
});
test('a bot cannot move the run row through shared completion', async () => {
  const { run } = await startPlaybookRun(options);
  const before = run.toObject();
  expect(await completeTaskWithRevision({ podId: pod._id, taskId: run.taskId }, { $set: { status: 'done' } },
    { userId: String(user._id), isBot: true, assignee: 'owner' })).toBeNull();
  expect((await Task.findById(run._id)).toObject()).toEqual(before);
});
test('a stored bot completion fails the record-based done check even when omitted by the definition', async () => {
  const { run, step } = await startPlaybookRun(options);
  await complete(step);
  const second = await Task.findOne({ parentTask: run.taskId, status: 'pending' });
  await Task.updateOne({ _id: second._id }, { $set: { status: 'done', completedBy: String(new mongoose.Types.ObjectId()) } });
  await advancePlaybookRun(String(pod._id), second.taskId);
  const blocked = await Task.findById(run._id);
  expect(blocked.status).toBe('blocked');
  expect(blocked.updates.at(-1).text).toContain('completion by a person required');
});
test('Off, disabled and malformed triggers create no run rows', async () => {
  await expect(startPlaybookRun({ ...options, triggerKey: 'push:unshipped' })).rejects.toMatchObject({ code: 'invalid_trigger' });
  delete process.env.PLAYBOOKS_ENABLED;
  await expect(startPlaybookRun(options)).rejects.toMatchObject({ code: 'playbooks_disabled' });
  process.env.PLAYBOOKS_ENABLED = 'true';
  await setPlaybookOn(String(pod._id), String(user._id), String(installation._id), {}, false);
  await expect(startPlaybookRun(options)).rejects.toMatchObject({ code: 'playbook_off' });
  expect(await Task.countDocuments()).toBe(0);
});
