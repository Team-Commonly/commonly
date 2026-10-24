/* eslint-disable import/no-unresolved, import/extensions */
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
jest.mock('../../models/AgentEvent', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../services/agentMentionService', () => ({ boardWakeEnabled: () => true }));

const { AgentInstallation } = require('../../models/AgentRegistry');
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
  });
});
afterAll(async () => {
  await clearMongoDb();
  await closeMongoDb();
});

it('atomically permits one nudge per seat and pod in a rolling 30-minute window', async () => {
  const [a, b] = await Promise.all([
    notifyFoundWork(podId, work, 1, now),
    notifyFoundWork(podId, work, 1, now),
  ]);
  expect(a.woken + b.woken).toBe(1);
  expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);

  const withinWindow = await notifyFoundWork(podId, work, 1, new Date(now.getTime() + 29 * 60 * 1000));
  expect(withinWindow.woken).toBe(0);
  expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);

  const nextWindow = await notifyFoundWork(podId, work, 1, new Date(now.getTime() + 31 * 60 * 1000));
  expect(nextWindow.woken).toBe(1);
  expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
  const install = await AgentInstallation.findOne({ podId, agentName: 'scout' }).lean();
  expect(install.lastFoundWorkAt).toEqual(new Date(now.getTime() + 31 * 60 * 1000));
});
