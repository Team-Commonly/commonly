/* eslint-disable import/no-unresolved, import/extensions */
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
jest.mock('../../models/AgentEvent', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue(null) }));

const { AgentInstallation } = require('../../models/AgentRegistry');
const Task = require('../../models/Task');
const User = require('../../models/User');
const AgentEventService = require('../../services/agentEventService');
const { notifyFoundWork } = require('../../services/taskEventService');

const podId = new mongoose.Types.ObjectId();
const now = new Date('2026-08-20T20:00:00.000Z');
const work = [{
  _id: new mongoose.Types.ObjectId(), taskId: 'TASK-UNCLAIMED', title: 'Unclaimed work', updatedAt: now,
}];

beforeAll(setupMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  jest.clearAllMocks();
  await AgentInstallation.create({
    agentName: 'scout',
    instanceId: 'default',
    podId,
    status: 'active',
    version: '1.0.0',
    installedBy: new mongoose.Types.ObjectId(),
    config: { boardWake: { enabled: true }, workDiscovery: { enabled: true, role: 'implementer' } },
  });
});
afterAll(async () => {
  await clearMongoDb();
  await closeMongoDb();
});

it('atomically permits one nudge per seat and pod in a rolling one-hour window', async () => {
  const [a, b] = await Promise.all([
    notifyFoundWork(podId, work, 1, now),
    notifyFoundWork(podId, work, 1, now),
  ]);
  expect(a.woken + b.woken).toBe(1);
  expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);

  const withinWindow = await notifyFoundWork(podId, work, 1, new Date(now.getTime() + 59 * 60 * 1000));
  expect(withinWindow.woken).toBe(0);
  expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);

  const nextWindow = await notifyFoundWork(podId, work, 1, new Date(now.getTime() + 60 * 60 * 1000));
  expect(nextWindow.woken).toBe(1);
  expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
  const install = await AgentInstallation.findOne({ podId, agentName: 'scout' }).lean();
  expect(install.lastFoundWorkAt).toEqual(new Date(now.getTime() + 60 * 60 * 1000));
});

it.each([
  ['assigned', { assignee: 'scout', status: 'pending' }],
  ['mixed-case assignment', { assignee: 'Scout', status: 'pending' }],
  ['claimed', { claimedBy: 'scout', status: 'claimed' }],
  ['mixed-case claim', { claimedBy: 'Scout', status: 'claimed' }],
])('does not reserve a slot for a reviewer or an implementer with %s', async (_kind, ownership) => {
  await AgentInstallation.create({
    agentName: 'sprint-review', instanceId: 'default', podId, status: 'active',
    version: '1.0.0', installedBy: new mongoose.Types.ObjectId(),
    config: { boardWake: { enabled: true }, workDiscovery: { enabled: true, role: 'reviewer' } },
  });
  await Task.create({
    podId, taskNum: 1, taskId: 'TASK-BUSY', title: 'Already owned',
    ...ownership,
  });

  const result = await notifyFoundWork(podId, work, 1, now);

  expect(result.woken).toBe(0);
  expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  const installs = await AgentInstallation.find({ podId }).lean();
  expect(installs.every((install) => install.lastFoundWorkAt == null)).toBe(true);
});

it('treats a bot-principal ObjectId claim as occupied capacity', async () => {
  const principalId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: principalId, isBot: true, botMetadata: { agentName: 'scout', instanceId: 'default' },
  });
  await Task.create({
    podId, taskNum: 2, taskId: 'TASK-PRINCIPAL', title: 'Claimed by bot principal',
    status: 'claimed', claimedBy: String(principalId),
  });

  const result = await notifyFoundWork(podId, work, 1, now);

  expect(result.woken).toBe(0);
  expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  const install = await AgentInstallation.findOne({ podId, agentName: 'scout' }).lean();
  expect(install.lastFoundWorkAt).toBeNull();
});
