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

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'u1';
  req.user = { id: 'u1', _id: 'u1' };
  next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());

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
  findOne: jest.fn(),
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
jest.mock('../../../services/taskEventService', () => ({
  emitTaskUpdated: (...args) => mockEmitTaskUpdated(...args),
}));

const mockRecordTaskAttention = jest.fn();
const mockResolveTaskAttention = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordTaskAttention: (...args) => mockRecordTaskAttention(...args),
  resolveTaskAttention: (...args) => mockResolveTaskAttention(...args),
}));

const tasksApi = require('../../../routes/tasksApi');

const app = express();
app.use(express.json());
app.use('/api/v1/tasks', tasksApi);

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockFindOneAndUpdate.mockResolvedValue({ taskId: 'TASK-001', status: 'claimed' });
  mockEmitTaskUpdated.mockReset();
  mockRecordTaskAttention.mockReset();
  mockRecordTaskAttention.mockResolvedValue(undefined);
  mockResolveTaskAttention.mockReset();
  mockResolveTaskAttention.mockResolvedValue(undefined);
});

describe('PATCH /:podId/:taskId status vocabulary', () => {
  test.each([
    ['in_progress', 'claimed'],
    ['In_Progress', 'claimed'],
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
    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-001`)
      .send({ title: 'renamed' });

    expect(res.status).toBe(200);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set.title).toBe('renamed');
  });
});
