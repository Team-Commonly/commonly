process.env.PG_HOST = '';
process.env.JWT_SECRET = 'tasks-source-ref-idempotency-test-secret';

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
const tasksApiRoutes = require('../../routes/tasksApi');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
} = require('../utils/testUtils');

describe('POST /api/v1/tasks/:podId sourceRef idempotency', () => {
  let app;
  let owner;
  let pod;
  let token;

  beforeAll(async () => {
    await setupMongoDb();
    await Task.init();
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    owner = await User.create({
      username: `task-owner-${Date.now()}`,
      email: `task-owner-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    pod = await Pod.create({
      name: 'Task idempotency pod',
      type: 'team',
      createdBy: owner._id,
      members: [owner._id],
    });
    token = generateTestToken(owner._id);
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const postTask = (body) => request(app)
    .post(`/api/v1/tasks/${pod._id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  const seedTask = (overrides = {}) => Task.create({
    podId: pod._id,
    taskNum: 1,
    taskId: 'TASK-001',
    title: 'Existing task',
    source: 'import',
    sourceRef: 'external:ticket:697',
    updates: [{
      text: 'Seeded for test',
      author: 'system',
      authorId: null,
      createdAt: new Date(),
    }],
    ...overrides,
  });

  it('returns an existing pending task through the pre-check', async () => {
    const existing = await seedTask();

    const response = await postTask({
      title: 'Retry of existing task',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.alreadyExists).toBe(true);
    expect(response.body.task._id).toBe(String(existing._id));
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(1);
  });

  it('keeps the pre-check reopen behavior for a completed task', async () => {
    const existing = await seedTask({ status: 'done', completedAt: new Date() });

    const response = await postTask({
      title: 'Still-active source record',
      sourceRef: 'external:ticket:697',
      assignee: 'codex',
    }).expect(200);

    expect(response.body).toMatchObject({
      alreadyExists: false,
      reopened: true,
      task: {
        _id: String(existing._id),
        status: 'pending',
        assignee: 'codex',
      },
    });
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(1);
  });

  it('preserves the completed run\'s notes in history and reports a differing submitted title', async () => {
    const existing = await seedTask({
      status: 'done',
      completedAt: new Date(),
      notes: 'Shipped as PR #1, squash-merged. Patch-id verified against the gated head.',
    });

    const response = await postTask({
      title: 'A follow-up filed against the same source',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.reopened).toBe(true);
    expect(response.body.task.title).toBe('Existing task');
    expect(response.body.task.notes).toContain('Submitted title ("A follow-up filed against the same source") was NOT applied');

    const reloaded = await Task.findById(existing._id);
    const history = reloaded.updates.map((u) => u.text).join('\n---\n');
    // The previous notes are the durable record of the completed run; a reopen
    // used to destroy them by overwriting `notes` with one sentence.
    expect(history).toContain('Previous notes preserved from the completed run');
    expect(history).toContain('Patch-id verified against the gated head.');
    expect(history).toContain('Submitted title differed and was not applied');
  });

  it('adds no conservation noise when the reopen changes nothing but the status', async () => {
    const existing = await seedTask({ status: 'done', completedAt: new Date() });

    const response = await postTask({
      title: 'Existing task',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.task.notes).toBe('Reopened — the same source is active again.');

    const reloaded = await Task.findById(existing._id);
    const history = reloaded.updates.map((u) => u.text).join('\n---\n');
    expect(history).not.toContain('Previous notes preserved');
    expect(history).not.toContain('Submitted title differed');
  });

  it('reconciles a sourceRef E11000 race as an idempotent 200', async () => {
    const existing = await seedTask();
    const findOneSpy = jest.spyOn(Task, 'findOne');
    findOneSpy.mockImplementationOnce(() => Promise.resolve(null));

    const response = await postTask({
      title: 'Concurrent retry',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.alreadyExists).toBe(true);
    expect(response.body.task._id).toBe(String(existing._id));
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(1);
  });

  it('does not misclassify a taskId E11000 as sourceRef idempotency', async () => {
    await seedTask({ sourceRef: 'external:ticket:different-source' });
    const findOneSpy = jest.spyOn(Task, 'findOne');
    // The sourceRef pre-check legitimately finds no match. Then force the
    // nextTaskId read to miss the existing TASK-001 so Mongo raises E11000
    // from the *taskId* index while the request still carries a sourceRef.
    findOneSpy.mockImplementationOnce(() => Promise.resolve(null));
    findOneSpy.mockImplementationOnce(() => ({
      sort: () => ({
        select: () => ({
          lean: () => Promise.resolve(null),
        }),
      }),
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await postTask({
      title: 'Colliding task number',
      sourceRef: 'external:ticket:697',
    }).expect(500);

    expect(response.body.alreadyExists).toBeUndefined();
    expect(response.body.error).toBe('Failed to create task');
    expect(await Task.countDocuments({ podId: pod._id, taskId: 'TASK-001' })).toBe(1);
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(0);
  });

  it('rejects an operator-shaped sourceRef before it reaches Mongo', async () => {
    const findOneSpy = jest.spyOn(Task, 'findOne');

    const response = await postTask({
      title: 'Attempted query injection',
      sourceRef: { $ne: null },
    }).expect(400);

    expect(response.body.error).toBe('sourceRef must be a string');
    expect(findOneSpy).not.toHaveBeenCalled();
    expect(await Task.countDocuments({ podId: pod._id })).toBe(0);
  });
});
