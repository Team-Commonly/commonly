/**
 * Task status vocabulary at the PATCH gate.
 *
 * findOneAndUpdate bypasses the schema enum validator, so PATCH is the only
 * thing standing between a caller's status string and the DB. Agent callers
 * write LLM-natural names (in_progress, completed) — unvalidated, those
 * landed in Mongo and the v1 board rendered the task in NO column while the
 * header still counted it. Aliases normalize; unknown values 400 with a
 * message that teaches the vocabulary.
 */
const request = require('supertest');
const express = require('express');

// A request with `x-test-seat` is a seat: `isSeatCaller` reads `req.agentUser` or
// `req.user.isBot`, the two signals a bot's auth sets. Any other request is a person.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'u1';
  req.user = { id: 'u1', _id: 'u1' };
  if (req.headers['x-test-seat']) {
    req.user.isBot = true;
    req.agentUser = { _id: 'u1' };
  }
  next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());

// The assignee resolver reads real pod members; it is covered in tasks.assignee-handle.test.js.
jest.mock('../../../services/taskAssigneeService', () => ({ canonicalAssignee: async (_podId, typed) => typed }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({
      type: 'chat',
      members: [{ toString: () => 'u1' }],
    }),
  })),
}));

const mockFindOneAndUpdate = jest.fn();
jest.mock('../../../models/Task', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  find: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ username: 'alice' }) })),
  })),
}));

jest.mock('../../../services/githubAppService', () => ({
  isPatConfigured: jest.fn(() => false),
}));

const mockEmitTaskUpdated = jest.fn();
const mockNotifyPodAgents = jest.fn();
jest.mock('../../../services/taskEventService', () => ({
  emitTaskUpdated: (...args) => mockEmitTaskUpdated(...args),
  notifyPodAgents: (...args) => mockNotifyPodAgents(...args),
}));

const mockRecordTaskAttention = jest.fn();
const mockResolveTaskAttention = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordTaskAttention: (...args) => mockRecordTaskAttention(...args),
  resolveTaskAttention: (...args) => mockResolveTaskAttention(...args),
}));

// The close hook writes RoomGrant, which this file's mocked Task cannot back.
// Its real-Mongo behaviour is covered in tasksApi.taskGrantClose.test.js.
const mockOnTaskClosed = jest.fn(async () => {});
jest.mock('../../../services/roomGrantService', () => ({
  onTaskClosed: (...args) => mockOnTaskClosed(...args),
}));

// The task-completed trigger (ADR-012 §4) writes system-exchange rows this file's mocked
// models cannot back. A PATCH to done fires it, the same as /complete does.
const mockRecordTaskCompleted = jest.fn(async () => {});
jest.mock('../../../services/systemExchangeTriggers', () => ({
  recordTaskCompleted: (...args) => mockRecordTaskCompleted(...args),
}));

const tasksApi = require('../../../routes/tasksApi');
const Task = require('../../../models/Task');

const app = express();
app.use(express.json());
app.use('/api/v1/tasks', tasksApi);

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockFindOneAndUpdate.mockResolvedValue({ taskId: 'TASK-001', status: 'claimed' });
  mockEmitTaskUpdated.mockReset();
  mockNotifyPodAgents.mockReset();
  // mockReset clears a queued mockResolvedValueOnce, so one test's read cannot leak into the next.
  Task.findOne.mockReset();
  Task.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  mockRecordTaskAttention.mockReset();
  mockRecordTaskAttention.mockResolvedValue(undefined);
  mockResolveTaskAttention.mockReset();
  mockResolveTaskAttention.mockResolvedValue(undefined);
  mockOnTaskClosed.mockClear();
  mockRecordTaskCompleted.mockClear();
});

describe('PATCH to done is one transition', () => {
  test('writes only a row that is not done yet, and stamps its completion time', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter.status).toEqual({ $ne: 'done' });
    expect(update.$set.completedAt).toBeInstanceOf(Date);
    expect(update.$inc).toEqual({ grantEpoch: 1 });
  });

  test('a repeated PATCH to done writes nothing and fires no close side effects', async () => {
    Task.findOne.mockResolvedValueOnce({ taskId: 'TASK-001', status: 'done' });

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('done');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskClosed).not.toHaveBeenCalled();
    expect(mockRecordTaskCompleted).not.toHaveBeenCalled();
  });
});

describe('PATCH /:podId/:taskId status vocabulary', () => {
  test.each([
    ['completed', 'done'],
    ['todo', 'pending'],
  ])("normalizes alias '%s' to canonical '%s'", async (alias, canonical) => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: alias });

    expect(res.status).toBe(200);
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe(canonical);
    // The audit-trail line records the canonical value, not the alias.
    expect(update.$push.updates.text).toContain(`status → ${canonical}`);
    // F42: the assigned-task wake re-arms on an update authored by someone other
    // than the assignee, so a status change must carry its author.
    expect(update.$push.updates.authorId).toBe('u1');
    expect(mockEmitTaskUpdated).toHaveBeenCalled();
  });

  test('passes canonical statuses through unchanged', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'blocked' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set.status).toBe('blocked');
  });

  test('materializes a blocked row at the status-write boundary', async () => {
    const task = { taskId: 'TASK-001', status: 'blocked', podId: POD_ID, updates: [] };
    mockFindOneAndUpdate.mockResolvedValueOnce(task);

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'blocked' });

    expect(res.status).toBe(200);
    expect(mockRecordTaskAttention).toHaveBeenCalledWith(task, { includeBlocked: true });
  });

  test('resolves task attention when a task leaves blocked state', async () => {
    const task = { taskId: 'TASK-001', status: 'done', podId: POD_ID, updates: [] };
    mockFindOneAndUpdate.mockResolvedValueOnce(task);

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(mockResolveTaskAttention).toHaveBeenCalledWith(task);
    expect(mockOnTaskClosed).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'TASK-001', status: 'done' }));
  });

  test('POST /complete resolves the task\'s outstanding handoffs, like a PATCH out of blocked does', async () => {
    // Measured 2026-09-19: 11 of 12 open handoff cards pointed at tasks already
    // `done` — every one completed through this route, which never told the
    // attention store. Only the PATCH gate did.
    const task = { _id: 'task-1', taskId: 'TASK-001', status: 'done', podId: POD_ID, updates: [] };
    Task.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ updatedAt: new Date(Date.now() - 1) }) }) });
    mockFindOneAndUpdate.mockResolvedValueOnce(task);
    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/TASK-001/complete`)
      .send({ prUrl: 'https://github.com/Team-Commonly/commonly/pull/1' });
    expect(res.status).toBe(200);
    expect(mockResolveTaskAttention).toHaveBeenCalledWith(expect.objectContaining({ _id: 'task-1' }));
    expect(mockOnTaskClosed).toHaveBeenCalledWith(expect.objectContaining({ _id: 'task-1', status: 'done' }));
    expect(mockNotifyPodAgents).toHaveBeenCalledWith(
      POD_ID, task, 'updated', expect.any(Object), { status: 'claimed' },
    );
  });

  test.each(['claimed', 'in_progress', 'In_Progress'])(
    "refuses status '%s' from a seat: a seat's claim is a lease, and this route writes none for a seat",
    async (status) => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
        .set('x-test-seat', '1')
        .send({ status });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/commonly_claim_task/);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  test.each(['claimed', 'in_progress', 'In_Progress'])(
    "accepts status '%s' from a person, and writes no lease",
    async (status) => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
        .send({ status });

      expect(res.status).toBe(200);
      const [, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(update.$set).toMatchObject({ status: 'claimed' });
      // A person's Start leaves whatever lease the row carries alone, as it does on main.
      expect(update.$set).not.toHaveProperty('claimedBy');
      expect(update.$set).not.toHaveProperty('claimedAt');
      expect(update.$set).not.toHaveProperty('claimExpiresAt');
      expect(update.$set).not.toHaveProperty('claimedByUserId');
    },
  );

  test('a PATCH to done is a completion: it stamps completedAt and fires the task-completed trigger', async () => {
    // A PATCH to done used to set the status and nothing else, so the row had no
    // completedAt and no ADR-012 §4 trigger, where /complete gives it both.
    const task = { _id: 'task-1', taskId: 'TASK-001', title: 'ship it', assignee: 'scout', status: 'claimed', podId: POD_ID, updates: [] };
    mockFindOneAndUpdate.mockResolvedValueOnce(task);

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set.completedAt).toBeInstanceOf(Date);
    expect(mockRecordTaskCompleted).toHaveBeenCalledWith({
      podId: POD_ID,
      assignee: 'scout',
      taskTitle: 'ship it',
      prUrlOrStatus: null,
    });
  });

  test('a PATCH to done on a row already done does not announce the completion again', async () => {
    // The early read is what makes this a repeat. The mock returns the done row for that
    // one read, so if the early check is removed the write runs and this test fails.
    const done = { _id: 'task-1', taskId: 'TASK-001', title: 'ship it', assignee: 'scout', status: 'done', podId: POD_ID, updates: [] };
    Task.findOne.mockResolvedValueOnce(done);

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRecordTaskCompleted).not.toHaveBeenCalled();
    expect(mockOnTaskClosed).not.toHaveBeenCalled();
  });

  test('rejects unknown statuses with the vocabulary in the error', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ status: 'wip' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pending\|claimed\|done\|blocked/);
    expect(res.body.error).toMatch(/'wip'/);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('non-status patches are unaffected by the gate', async () => {
    Task.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ updatedAt: new Date(Date.now() - 1) }) }) });
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ title: 'renamed' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set.title).toBe('renamed');
    expect(mockFindOneAndUpdate.mock.calls[0][2]).toEqual({ new: true, timestamps: false });
  });

  test('passes the prior assignee to board wake routing when unassigning', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({ taskId: 'TASK-001', assignee: 'scout', status: 'claimed' });

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ assignee: '' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate.mock.calls[0][2]).toEqual({ new: false, timestamps: false });
    expect(mockNotifyPodAgents).toHaveBeenCalledWith(
      POD_ID, expect.objectContaining({ assignee: null }), 'updated',
      expect.any(Object), { assignee: 'scout', claimedBy: undefined, status: 'claimed' },
    );
  });

  test('gets prior ownership from the successful atomic write', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({ taskId: 'TASK-001', assignee: 'alpha', status: 'pending' });
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ assignee: 'scout' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockNotifyPodAgents).toHaveBeenCalledWith(
      POD_ID, expect.objectContaining({ assignee: 'scout' }), 'updated',
      expect.any(Object), { assignee: 'alpha', claimedBy: undefined, status: 'pending' },
    );
  });
});
