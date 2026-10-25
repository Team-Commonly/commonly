const { randomUUID } = require('crypto');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const Installation = require('../../models/InstallableInstallation');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { createOffPlaybook, setPlaybookOn } = require('../../services/playbooks/store');
const { runPlaybookManually, tickPlaybookSchedules, reconcilePlaybookRuns } = require('../../services/playbooks/runner');
const Events = require('../../services/agentEventService');
let human; let agent; let pod; let installation;
const originalFlag = process.env.PLAYBOOKS_ENABLED;
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); jest.clearAllMocks(); process.env.PLAYBOOKS_ENABLED = 'true';
  human = await User.create({ username: 'owner', email: 'owner@example.test', password: 'test-password' });
  agent = await User.create({ username: 'worker', email: 'worker@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'byo-worker', instanceId: 'worker' } });
  pod = await Pod.create({ name: 'Recovery', members: [human._id, agent._id], createdBy: human._id });
  await AgentInstallation.create({ agentName: 'byo-worker', instanceId: 'worker', version: '1', podId: pod._id,
    installedBy: human._id, config: { runtime: { runtimeType: 'webhook' } } });
  installation = await createOffPlaybook(String(pod._id), String(human._id), { title: 'Do work',
    schedule: { cron: '0 9 * * *', timezone: 'UTC' }, definition: {
      v: 1, roles: [{ key: 'worker', kind: 'agent' }],
      steps: [{ key: 'work', title: 'Work', role: 'worker', do: 'Do it' }],
      done: [{ says: 'Done', check: 'done', step: 'work' }],
    } });
  await setPlaybookOn(String(pod._id), String(human._id), String(installation._id), { worker: String(agent._id) }, true);
});
afterEach(() => { if (originalFlag === undefined) delete process.env.PLAYBOOKS_ENABLED;
  else process.env.PLAYBOOKS_ENABLED = originalFlag; });
const run = () => runPlaybookManually({ podId: String(pod._id), installationId: String(installation._id),
  userId: String(human._id), requestId: randomUUID(), input: 'Work' });

test('a repeated minute and concurrent replica ticks produce one run and addressed wake', async () => {
  await Installation.updateOne({ _id: installation._id }, { $set: { 'components.0.config.onAt': new Date('2026-10-26T08:00:00Z') } });
  const now = new Date('2026-10-26T09:30:00Z');
  await Promise.all([tickPlaybookSchedules(now), tickPlaybookSchedules(now)]);
  await tickPlaybookSchedules(now);
  expect(await Task.countDocuments({ parentTask: null })).toBe(1);
  expect(Events.enqueue).toHaveBeenCalledTimes(1);
  expect(Events.enqueue.mock.calls[0][0]).toMatchObject({ agentName: 'byo-worker', instanceId: 'worker',
    payload: { triggerAuthor: 'kernel' } });
  expect((await Task.findOne({ parentTask: null })).sourceRef).toContain('schedule:2026-10-26T09:00');
});
test('a root left without its first step is recovered without another run', async () => {
  const started = await run();
  await Task.deleteOne({ _id: started.step._id }); Events.enqueue.mockClear();
  await Promise.all([reconcilePlaybookRuns(), reconcilePlaybookRuns()]);
  expect(await Task.countDocuments({ parentTask: started.run.taskId })).toBe(1);
  expect(await Task.countDocuments({ parentTask: null })).toBe(1);
  expect(Events.enqueue).toHaveBeenCalledTimes(1);
});
test('an unclaimed BYO step is re-woken only once after thirty minutes and keeps its assignee', async () => {
  const started = await run();
  const now = new Date();
  await Task.updateOne({ _id: started.step._id }, { $set: { offeredAt: new Date(now.getTime() - 31 * 60000) } });
  await Promise.all([reconcilePlaybookRuns(now), reconcilePlaybookRuns(now)]);
  expect(Events.enqueue).toHaveBeenCalledTimes(2);
  const row = await Task.findById(started.step._id);
  expect(row.assignee).toBe('worker'); expect(row.rescueDeferrals).toBe(1);
  await Task.updateOne({ _id: row._id }, { $set: { offeredAt: new Date(now.getTime() - 31 * 60000) } });
  await reconcilePlaybookRuns(now);
  expect(Events.enqueue).toHaveBeenCalledTimes(2);
});
test('disabled rollout jobs do not create or advance rows', async () => {
  delete process.env.PLAYBOOKS_ENABLED;
  await tickPlaybookSchedules(); await reconcilePlaybookRuns();
  expect(await Task.countDocuments()).toBe(0);
  expect(Events.enqueue).not.toHaveBeenCalled();
});
