/**
 * Title and assignee are single-line on every write path (TASK-354).
 *
 * A newline in a title breaks each single-line surface that renders it, and an
 * assignee with an inner space or control character names a different actor to
 * claims and the wake, which match it verbatim. Case is left alone on purpose:
 * the name is the identity, and lowering it would merge two real names.
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
    lean: jest.fn().mockResolvedValue({ type: 'chat', members: [{ toString: () => 'u1' }] }),
  })),
}));

const mockCreate = jest.fn();
const mockFindOneAndUpdate = jest.fn();
jest.mock('../../../models/Task', () => ({
  find: jest.fn(() => ({ sort: () => ({ lean: async () => [] }) })),
  findOne: jest.fn(() => ({
    sort: () => ({ lean: async () => null, select: () => ({ lean: async () => null }) }),
    select: () => ({ lean: async () => ({ updatedAt: new Date(0), assignee: null, claimedBy: null }) }),
    lean: async () => null,
  })),
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  countDocuments: jest.fn().mockResolvedValue(0),
  create: (...args) => mockCreate(...args),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ username: 'alice' }) })),
  })),
}));

const tasksApiRoutes = require('../../../routes/tasksApi');

const POD = '69b7ddff0ce64c9648365fc4';
const TASK = '69b7ddff0ce64c9648365fc5';

describe('task title and assignee normalization on write (TASK-354)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockImplementation(async (doc) => ({
      ...doc,
      toObject() { return doc; },
    }));
    mockFindOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...update.$set,
      toObject() { return update.$set; },
    }));
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  describe('POST create', () => {
    test('a newline in the title collapses to one line before it is stored', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: '  Fix the\r\n  board   lease\nrow  ' });
      expect(res.status).toBe(201);
      expect(mockCreate.mock.calls[0][0].title).toBe('Fix the board lease row');
    });

    test('a title that is only a newline is refused as empty', async () => {
      const res = await request(app).post(`/api/v1/tasks/${POD}`).send({ title: '\n' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('title is required');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('the assignee is trimmed and its case is kept', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: 'Ship it', assignee: '  Nova  ' });
      expect(res.status).toBe(201);
      expect(mockCreate.mock.calls[0][0].assignee).toBe('Nova');
    });

    test('an assignee with an inner space is refused before anything is stored', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: 'Ship it', assignee: 'nova ops' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/assign by handle/);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('an assignee with a control character is refused', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: 'Ship it', assignee: 'nova\u0007' });
      expect(res.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('a control character from the C1 range is refused too', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: 'Ship it', assignee: 'nova\u0085' });
      expect(res.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('a replay looks up a row stored under the raw multiline title too', async () => {
      const Task = require('../../../models/Task');
      await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: 'Fix\nboard', sourceRef: 'msg:1' });
      const filter = Task.findOne.mock.calls[0][0];
      expect(filter.title).toEqual({ $in: ['Fix board', 'Fix\nboard'] });
    });

    test('a blank assignee stores as unassigned', async () => {
      const res = await request(app)
        .post(`/api/v1/tasks/${POD}`)
        .send({ title: 'Ship it', assignee: '   ' });
      expect(res.status).toBe(201);
      expect(mockCreate.mock.calls[0][0].assignee).toBeNull();
    });
  });

  describe('PATCH update', () => {
    test('a newline in the title collapses to one line before the write', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD}/${TASK}`)
        .send({ title: 'Renamed\nin two lines' });
      expect(res.status).toBe(200);
      expect(mockFindOneAndUpdate.mock.calls[0][1].$set.title).toBe('Renamed in two lines');
    });

    test('a non-string title is refused before the write, so null never reaches Mongo', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD}/${TASK}`)
        .send({ title: null });
      expect(res.status).toBe(400);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    test('an assignee with an inner space is refused before the write', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD}/${TASK}`)
        .send({ assignee: 'sprint impl' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/assign by handle/);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a padded assignee is trimmed on the write', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD}/${TASK}`)
        .send({ assignee: ' Lily ' });
      expect(res.status).toBe(200);
      expect(mockFindOneAndUpdate.mock.calls[0][1].$set.assignee).toBe('Lily');
    });

    test('a title that is only whitespace is refused rather than stored blank', async () => {
      const res = await request(app)
        .patch(`/api/v1/tasks/${POD}/${TASK}`)
        .send({ title: ' \n ' });
      expect(res.status).toBe(400);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
