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

// TASK-063. A create's identity is the (sourceRef, title) PAIR. Everything in
// this file follows from that one sentence: the same pair is an idempotent
// retry (200, nothing mutated), a different title under the same ref is a
// different ask (201, its own row), and a completed row can only be reopened by
// the ask that completed it.
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
      title: 'Existing task',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.alreadyExists).toBe(true);
    expect(response.body.reopened).toBeUndefined();
    expect(response.body.task._id).toBe(String(existing._id));
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(1);
  });

  it('creates a second row when one sourceRef carries a different ask', async () => {
    // The 58290 incident: one message raised two asks with two owners, the
    // filer used the message id as the ref for both, and the second ask came
    // back holding the first ask's row with its own title discarded.
    const first = await seedTask();

    const response = await postTask({
      title: 'Second ask from the same source',
      sourceRef: 'external:ticket:697',
      assignee: 'pod-architect',
    }).expect(201);

    expect(response.body.task._id).not.toBe(String(first._id));
    expect(response.body.task.title).toBe('Second ask from the same source');
    expect(response.body.task.assignee).toBe('pod-architect');
    expect(response.body.alreadyExists).toBeUndefined();
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(2);

    const reloadedFirst = await Task.findById(first._id);
    expect(reloadedFirst.title).toBe('Existing task');
    expect(reloadedFirst.status).toBe('pending');
  });

  it('keeps the pre-check reopen behavior for a completed task', async () => {
    const existing = await seedTask({ status: 'done', completedAt: new Date() });

    const response = await postTask({
      title: 'Existing task',
      sourceRef: 'external:ticket:697',
      assignee: 'codex',
    }).expect(200);

    // `alreadyExists: true` because it does: this request did not create a row,
    // it reopened one. It used to answer `false`, and a caller branches on that
    // field to decide whether its create landed, so the caller concluded it had
    // created a task while holding a different task's row.
    expect(response.body).toMatchObject({
      alreadyExists: true,
      reopened: true,
      task: {
        _id: String(existing._id),
        status: 'pending',
        assignee: 'codex',
        title: 'Existing task',
      },
    });
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(1);
  });

  it('does not reopen a completed row when the submitted title differs', async () => {
    // TASK-163, reproduced live 2026-09-25T08:09Z: a create with a done row's
    // ref put that row back to pending under a title its caller never chose,
    // and the caller's own ask was never filed.
    const completed = await seedTask({
      status: 'done',
      completedAt: new Date(),
      notes: 'Shipped as PR #1169, squash-merged. Patch-id verified against the gated head.',
    });
    const updatesBefore = (await Task.findById(completed._id)).updates.length;

    const response = await postTask({
      title: 'A follow-up filed against the same source',
      sourceRef: 'external:ticket:697',
    }).expect(201);

    expect(response.body.task.title).toBe('A follow-up filed against the same source');
    expect(response.body.task._id).not.toBe(String(completed._id));

    const reloaded = await Task.findById(completed._id);
    expect(reloaded.status).toBe('done');
    expect(reloaded.notes).toBe('Shipped as PR #1169, squash-merged. Patch-id verified against the gated head.');
    expect(reloaded.updates.length).toBe(updatesBefore);
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(2);
  });

  it('preserves the completed run\'s notes in history when a reopen does fire', async () => {
    const existing = await seedTask({
      status: 'done',
      completedAt: new Date(),
      notes: 'Shipped as PR #1, squash-merged. Patch-id verified against the gated head.',
    });

    const response = await postTask({
      title: 'Existing task',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.reopened).toBe(true);
    expect(response.body.task.title).toBe('Existing task');
    expect(response.body.task.notes).toBe('Reopened — the same source is active again.');

    const reloaded = await Task.findById(existing._id);
    const history = reloaded.updates.map((u) => u.text).join('\n---\n');
    // The previous notes are the durable record of the completed run; a reopen
    // used to destroy them by overwriting `notes` with one sentence.
    expect(history).toContain('Previous notes preserved from the completed run');
    expect(history).toContain('Patch-id verified against the gated head.');
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
  });

  it('reconciles a sourceRef E11000 race as an idempotent 200', async () => {
    const existing = await seedTask();
    const findOneSpy = jest.spyOn(Task, 'findOne');
    findOneSpy.mockImplementationOnce(() => Promise.resolve(null));

    // Same ref AND same title: the insert really does collide on the pair
    // index, so this exercises the E11000 classification against a live index
    // rather than a mock of one.
    const response = await postTask({
      title: 'Existing task',
      sourceRef: 'external:ticket:697',
    }).expect(200);

    expect(response.body.alreadyExists).toBe(true);
    expect(response.body.task._id).toBe(String(existing._id));
    expect(await Task.countDocuments({ podId: pod._id, sourceRef: 'external:ticket:697' })).toBe(1);
  });

  it('answers a named 503 when the database still carries the ref-only index', async () => {
    // Deploy-order guard: with the pre-TASK-063 index still in place, a second
    // title under one ref collides there, so the create the caller asked for is
    // not one this database can perform. Fail with the migration's name rather
    // than a generic 500.
    await seedTask({ status: 'done', completedAt: new Date() });
    jest.spyOn(Task, 'findOne').mockImplementationOnce(() => Promise.resolve(null));
    jest.spyOn(Task, 'create').mockRejectedValueOnce(Object.assign(
      new Error('E11000 duplicate key error collection: commonly.tasks index: podId_1_sourceRef_1_partial dup key'),
      { code: 11000, keyPattern: { podId: 1, sourceRef: 1 } },
    ));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await postTask({
      title: 'A second ask, on a legacy index',
      sourceRef: 'external:ticket:697',
    }).expect(503);

    expect(response.body.code).toBe('task_source_ref_index_migration_pending');
    expect(response.body.error).toContain('migrate:task-source-ref-identity');
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
