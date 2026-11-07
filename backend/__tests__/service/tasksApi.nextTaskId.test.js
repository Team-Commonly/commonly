/**
 * Scout's first task is an N- row. Sorted by taskId, it was the pod's only row,
 * so the next task a person added parsed to NaN and failed. Real Mongo, because
 * the bug lives in what the sort and the query return.
 */
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const Task = require('../../models/Task');
const { nextTaskId } = require('../../routes/tasksApi');

const POD = '507f1f77bcf86cd799439011';
const row = (taskId, taskNum) => Task.create({ podId: POD, taskId, taskNum, title: taskId, status: 'done' });

describe('nextTaskId', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  test('a pod holding only a native row starts at TASK-001', async () => {
    await row('N-1-scout-abc', 1);

    await expect(nextTaskId(POD)).resolves.toEqual({ taskId: 'TASK-001', taskNum: 1 });
  });

  test('counts on from the last TASK row beside a native row', async () => {
    await row('N-1-scout-abc', 1);
    await row('TASK-004', 4);

    await expect(nextTaskId(POD)).resolves.toEqual({ taskId: 'TASK-005', taskNum: 5 });
  });
});
