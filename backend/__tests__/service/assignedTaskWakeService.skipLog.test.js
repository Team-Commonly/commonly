const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
const Task = require('../../models/Task');
const User = require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const AgentRun = require('../../models/AgentRun');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { dispatchAssignedTaskWakes } = require('../../services/assignedTaskWakeService');

// The skip log is rate-limited in memory for the life of the module, so each
// test runs at its own hour and cannot be silenced by an earlier one.
const START = new Date('2026-10-24T11:00:00Z').getTime();
let hour = 0;
let now;
const minutesFrom = (base, minutes) => new Date(base.getTime() + minutes * 60000);
let podId;
let debug;

async function completed(minutesAgo) {
  const at = minutesFrom(now, -minutesAgo);
  return AgentEvent.collection.insertOne({
    agentName: 'codex',
    instanceId: 'forge',
    podId,
    type: 'chat.mention',
    status: 'acked',
    deliveryMode: 'wake',
    delivery: { outcome: 'no_action', reasonRecorded: true, updatedAt: at },
    createdAt: at,
    updatedAt: at,
  });
}

async function fixture({ principal = true } = {}) {
  podId = new mongoose.Types.ObjectId();
  const installer = await User.create({
    username: 'forge-skip-installer', email: 'forge-skip-installer@example.test', password: 'test-password',
  });
  if (principal) {
    await User.create({
      username: 'forge-skip-test',
      email: 'forge-skip@example.test',
      password: 'test-password',
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'codex', instanceId: 'forge' },
    });
  }
  await AgentInstallation.create({
    agentName: 'codex', instanceId: 'forge', podId, version: '1', installedBy: installer._id, status: 'active',
  });
  await Task.create({
    podId, taskNum: 1, taskId: 'TASK-1', title: 'Do the assigned work', assignee: 'forge',
  });
}

const skips = () => debug.mock.calls.map(([line]) => line)
  .filter((line) => String(line).startsWith('[assigned-task-wake] skip'));

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  hour += 1;
  now = new Date(START + hour * 3600000);
  await clearMongoDb();
  debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => debug.mockRestore());

it('names the seat, the rows and the gate, once per thirty minutes', async () => {
  await fixture();
  await completed(2);
  await dispatchAssignedTaskWakes(now);
  await dispatchAssignedTaskWakes(minutesFrom(now, 1));
  expect(skips()).toEqual(['[assigned-task-wake] skip seat=codex/forge rows=TASK-1 gate=delay']);
  await AgentRun.create({
    agentName: 'codex', instanceId: 'forge', podId, trigger: 'mention', status: 'running',
  });
  await dispatchAssignedTaskWakes(minutesFrom(now, 10));
  await dispatchAssignedTaskWakes(minutesFrom(now, 20));
  expect(skips()).toEqual([
    '[assigned-task-wake] skip seat=codex/forge rows=TASK-1 gate=delay',
    '[assigned-task-wake] skip seat=codex/forge rows=TASK-1 gate=other-work',
  ]);
  await dispatchAssignedTaskWakes(minutesFrom(now, 40));
  expect(skips()).toHaveLength(3);
  expect(skips()[2]).toBe('[assigned-task-wake] skip seat=codex/forge rows=TASK-1 gate=other-work');
});

it('logs nothing when the seat is woken, then names the seat interval', async () => {
  await fixture();
  await completed(6);
  expect((await dispatchAssignedTaskWakes(now)).woken).toBe(1);
  expect(skips()).toEqual([]);
  expect((await dispatchAssignedTaskWakes(minutesFrom(now, 10))).woken).toBe(0);
  expect(skips()).toEqual(['[assigned-task-wake] skip seat=codex/forge rows=TASK-1 gate=seat-interval']);
});

it('names a seat with assigned rows but no principal', async () => {
  await fixture({ principal: false });
  await completed(6);
  await dispatchAssignedTaskWakes(now);
  expect(skips()).toEqual(['[assigned-task-wake] skip seat=codex/forge rows=TASK-1 gate=no-principal']);
});

it('names the row a self-created wake is holding for a person', async () => {
  await fixture();
  await Task.updateOne({ podId, taskId: 'TASK-1' }, { $set: { source: 'agent', taskId: 'N-1-codex-abc' } });
  await completed(6);
  expect((await dispatchAssignedTaskWakes(now)).woken).toBe(1);
  expect((await dispatchAssignedTaskWakes(minutesFrom(now, 45))).woken).toBe(0);
  expect(skips()).toEqual(['[assigned-task-wake] skip seat=codex/forge rows=N-1-codex-abc gate=awaiting-human']);
});
