const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/agentMessageService', () => ({ _postToTarget: jest.fn() }));
jest.mock('../../services/agentMentionService', () => ({ boardWakeEnabled: () => true }));

const Task = require('../../models/Task');
const User = require('../../models/User');
const Installation = require('../../models/InstallableInstallation');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const { completeTaskForMergedPull } = require('../../services/githubGigService');
const { dispatchAssignedTaskWakes } = require('../../services/assignedTaskWakeService');
const { notifyPodAgents, notifyFoundWork, bindSocketIO } = require('../../services/taskEventService');
const KernelWorkSweep = require('../../services/kernelWorkSweepService');
const reconciler = require('../../services/installable/installableReconciler');
let podId;

const seed = (extra = {}) => Task.create({ podId, taskId: 'TASK-001', taskNum: 1,
  title: 'Playbook step', source: 'playbook', assignee: 'worker', ...extra });

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => { await clearMongoDb(); podId = new mongoose.Types.ObjectId(); jest.clearAllMocks(); });

test('merged-PR auto-completion leaves a playbook row byte-for-byte unchanged and emits nothing', async () => {
  const prUrl = 'https://github.com/Team-Commonly/commonly/pull/1';
  const row = await seed({ prUrl, status: 'claimed', claimedBy: 'worker', completedBy: 'prior' });
  const emit = jest.fn(); bindSocketIO({ to: () => ({ emit }) });
  await completeTaskForMergedPull(String(podId), prUrl);
  expect(await Task.findById(row._id).lean()).toEqual(row.toObject());
  expect(emit).not.toHaveBeenCalled(); bindSocketIO(null);
});

test('a normal merged-PR task completes without inventing a person completer', async () => {
  const prUrl = 'https://github.com/Team-Commonly/commonly/pull/2';
  const row = await seed({ prUrl, source: 'agent', completedBy: 'prior' });
  await completeTaskForMergedPull(String(podId), prUrl);
  const updated = await Task.findById(row._id).lean();
  expect(updated.status).toBe('done'); expect(updated.completedBy).toBeUndefined();
});

test('lapse rescue leaves a playbook row and its assignee unchanged', async () => {
  const row = await seed({ status: 'claimed', claimedBy: 'worker', claimExpiresAt: new Date(0) });
  expect(await KernelWorkSweep.rescueLapsed(new Date())).toEqual({ rescued: [], deferred: [] });
  expect(await Task.findById(row._id).lean()).toEqual(row.toObject());
});

test('ambient, found-work and assigned-task wakes skip playbook rows', async () => {
  const row = await seed();
  const agent = await User.create({ username: 'worker', email: 'worker@example.test',
    password: 'test-password', isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'worker' } });
  await AgentInstallation.create({ agentName: 'codex', instanceId: 'worker', podId, version: '1', installedBy: agent._id });
  await notifyPodAgents(podId, row.toObject(), 'created');
  expect(await notifyFoundWork(podId, [row.toObject()], 1)).toEqual({ woken: 0 });
  expect(await dispatchAssignedTaskWakes()).toEqual({ eligible: 0, woken: 0 });
  expect(AgentEventService.enqueue).not.toHaveBeenCalled();
});

test('an active installation with no channel projection survives the connector reconciler', async () => {
  const installedBy = new mongoose.Types.ObjectId();
  const row = await Installation.create({ installableId: 'playbook:test', installedBy, targetType: 'pod',
    targetId: podId, scope: 'pod', installSource: 'ui', installableVersion: '1.0.0', status: 'active',
    components: [{ componentName: 'playbook', componentType: 'event-handler', instanceId: 'default', status: 'active' }] });
  await reconciler.sweep();
  expect(await Installation.findById(row._id).lean()).toEqual(row.toObject({ flattenMaps: true }));
});
