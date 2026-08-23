/**
 * Query-parameter coercion at the task list boundary.
 *
 * Express's extended query parser is the whole problem: `?assignee[$ne]=x`
 * arrives as an OBJECT and `?status=a&status=b` as an ARRAY. Destructured
 * straight out of req.query, the first reached Mongo as an operator and the
 * second turned `status.includes(',')` into Array.includes — a predicate that
 * still reads like a substring test while meaning something else.
 *
 * These assert on the QUERY OBJECT handed to Task.find rather than on the
 * response, because the response cannot distinguish "operator rejected" from
 * "operator ran and matched everything" — an unfiltered list returns every
 * pod task either way, which is exactly why this was invisible.
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

const mockFind = jest.fn();
jest.mock('../../../models/Task', () => ({
  find: (...args) => mockFind(...args),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ username: 'alice' }) })),
  })),
}));

const tasksApiRoutes = require('../../../routes/tasksApi');

const POD = '69b7ddff0ce64c9648365fc4';

describe('GET /api/v1/tasks/:podId — query coercion at the boundary', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  // Domain guard, by the rule these tests are an instance of: every assertion
  // below is negative-form (`not.toHaveProperty`), and a negative passes on a
  // subject that does not exist. Asserting the query is well-formed FIRST means
  // "the key is absent" can only mean the coercion dropped it — never that the
  // handler bailed, that `find` ran with undefined, or that the shape changed
  // underneath. Positive-form assertions need no such guard: `toBe('nova')`
  // fails honestly on undefined.
  const queryPassedToMongo = () => {
    const q = mockFind.mock.calls[0][0];
    expect(q).toHaveProperty('podId');
    return q;
  };

  test('an operator object in assignee never reaches the query', async () => {
    const res = await request(app).get(`/api/v1/tasks/${POD}?assignee[$ne]=nova`);
    expect(res.status).toBe(200);
    expect(queryPassedToMongo()).not.toHaveProperty('assignee');
  });

  test('an operator object in status never reaches the query', async () => {
    const res = await request(app).get(`/api/v1/tasks/${POD}?status[$ne]=done`);
    expect(res.status).toBe(200);
    expect(queryPassedToMongo()).not.toHaveProperty('status');
  });

  test('a repeated status param is an array, and is dropped rather than misread', async () => {
    const res = await request(app).get(`/api/v1/tasks/${POD}?status=pending&status=claimed`);
    expect(res.status).toBe(200);
    expect(queryPassedToMongo()).not.toHaveProperty('status');
  });

  test('claimable only fires on the exact string, so an array cannot force it', async () => {
    await request(app).get(`/api/v1/tasks/${POD}?claimable[]=true`);
    expect(queryPassedToMongo()).not.toHaveProperty('$or');
    jest.clearAllMocks();
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    await request(app).get(`/api/v1/tasks/${POD}?claimable=true`);
    expect(queryPassedToMongo()).toHaveProperty('$or');
  });

  test('legitimate string filters still work, comma list included', async () => {
    await request(app).get(`/api/v1/tasks/${POD}?assignee=nova&status=pending,claimed`);
    const q = queryPassedToMongo();
    expect(q.assignee).toBe('nova');
    expect(q.status).toEqual({ $in: ['pending', 'claimed'] });
  });
});
