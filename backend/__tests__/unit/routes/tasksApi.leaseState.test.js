/**
 * `leaseState` must agree with the claim CAS — and must NOT be read as
 * claimability.
 *
 * ADR-018 D4 made a claim a lease, and the claim route honours it: four ways to
 * win, including two that recognise an expired hold. The LIST route never did —
 * it filtered on stored `status` alone, so a task abandoned by a dead claimant
 * was claimable and unfindable at the same time. Claim takes a taskId and never
 * scans, so the only seat that could reach the row was the one that died holding
 * it, and nothing sweeps lapsed claims back to `pending`.
 *
 * These run against a real in-memory Mongo so the CAS's `$or` is evaluated by
 * Mongo itself, not by a second copy of the predicate written in the test. A
 * mocked Task model would assert only that the route calls findOneAndUpdate.
 *
 * Two invariants, and the second is the one that decays quietly:
 *  1. For a live row (pending|claimed), `leaseState !== 'held'` iff a STRANGER's
 *     claim succeeds.
 *  2. `held` does NOT mean "do not attempt", and `unleased` does NOT mean
 *     "available" — leaseState describes the LEASE, not the caller's rights.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = req.get('x-test-user') || 'holder';
  req.user = { id: req.userId, _id: req.userId };
  next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({
      type: 'chat',
      members: [{ toString: () => 'holder' }, { toString: () => 'stranger' }],
    }),
  })),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ username: 'tester' }) })),
  })),
}));

jest.mock('../../../services/githubAppService', () => ({ isPatConfigured: jest.fn(() => false) }));
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: jest.fn() }));

const Task = require('../../../models/Task');
const tasksApi = require('../../../routes/tasksApi');

const MIN = 60 * 1000;
const LEASE_MS = 30 * MIN;

let mongod;
let app;

// Each row states what it is and what the CAS must do with it. `strangerWins`
// is the CAS's answer, asserted against the route rather than assumed.
const ROWS = [
  {
    taskId: 'TASK-001',
    label: 'pending, never claimed',
    doc: { status: 'pending' },
    leaseState: 'unleased',
    strangerWins: true,
  },
  {
    taskId: 'TASK-002',
    label: 'claimed, lease live',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - 5 * MIN),
      claimExpiresAt: () => new Date(Date.now() + 25 * MIN),
    },
    leaseState: 'held',
    strangerWins: false,
  },
  {
    taskId: 'TASK-003',
    label: 'claimed, lease expired',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - 90 * MIN),
      claimExpiresAt: () => new Date(Date.now() - 60 * MIN),
    },
    leaseState: 'lapsed',
    strangerWins: true,
  },
  {
    taskId: 'TASK-004',
    label: 'legacy claim (no claimExpiresAt), older than one lease',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - LEASE_MS - MIN),
      claimExpiresAt: null,
    },
    leaseState: 'lapsed',
    strangerWins: true,
  },
  {
    taskId: 'TASK-005',
    label: 'legacy claim, still inside one lease',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - 5 * MIN),
      claimExpiresAt: null,
    },
    leaseState: 'held',
    strangerWins: false,
  },
  {
    taskId: 'TASK-006',
    label: 'claimed with neither timestamp — unprovable, so held',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: null,
      claimExpiresAt: null,
    },
    leaseState: 'held',
    strangerWins: false,
  },
  // Near-edge rows: seconds either side of the lease, where the extremes above are
  // hours. They catch a sign flip, a wrong constant, or a unit error.
  //
  // They do NOT catch strict-vs-inclusive. Mutating the field's `<` to `<=` leaves
  // all 28 green, because the two differ only at exact equality and nothing here is
  // exactly equal. That case is unreachable through this surface at all: the route
  // generates its own `now` inside the request, so a test cannot place a timestamp
  // on it. Stated rather than implied — a row labelled 'boundary' reads as covering
  // the boundary, and this one covers its neighbourhood.
  {
    taskId: 'TASK-009',
    label: 'lease expires in 5s — inside the edge',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - 25 * MIN),
      claimExpiresAt: () => new Date(Date.now() + 5000),
    },
    leaseState: 'held',
    strangerWins: false,
  },
  {
    taskId: 'TASK-010',
    label: 'lease expired 2s ago — just outside',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - 30 * MIN - 2000),
      claimExpiresAt: () => new Date(Date.now() - 2000),
    },
    leaseState: 'lapsed',
    strangerWins: true,
  },
  {
    taskId: 'TASK-011',
    label: 'legacy claim 5s short of one lease — inside the edge',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - LEASE_MS + 5000),
      claimExpiresAt: null,
    },
    leaseState: 'held',
    strangerWins: false,
  },
  {
    taskId: 'TASK-012',
    label: 'legacy claim 2s past one lease — just outside',
    doc: {
      status: 'claimed',
      claimedBy: 'holder',
      claimedAt: () => new Date(Date.now() - LEASE_MS - 2000),
      claimExpiresAt: null,
    },
    leaseState: 'lapsed',
    strangerWins: true,
  },
];

// Terminal rows: no lease is held, so `unleased` is literally true — and the CAS
// still refuses them. This pair is the whole reason the field is not named
// `claimable`.
const TERMINAL = [
  {
    taskId: 'TASK-007', label: 'done', doc: { status: 'done' }, leaseState: 'unleased', strangerWins: false,
  },
  {
    taskId: 'TASK-008', label: 'blocked', doc: { status: 'blocked' }, leaseState: 'unleased', strangerWins: false,
  },
];

const materialize = (row, num) => {
  const d = row.doc;
  return {
    podId: mongoose.Types.ObjectId.createFromHexString(POD_ID),
    taskNum: num,
    taskId: row.taskId,
    title: row.label,
    status: d.status,
    claimedBy: d.claimedBy || null,
    claimedAt: typeof d.claimedAt === 'function' ? d.claimedAt() : (d.claimedAt || null),
    claimExpiresAt: typeof d.claimExpiresAt === 'function' ? d.claimExpiresAt() : (d.claimExpiresAt || null),
  };
};

const listed = async () => {
  const res = await request(app).get(`/api/v1/tasks/${POD_ID}`).set('x-test-user', 'stranger');
  expect(res.status).toBe(200);
  return new Map(res.body.tasks.map((t) => [t.taskId, t]));
};

describe('task leaseState', () => {
  beforeAll(async () => {
    // eslint-disable-next-line global-require
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApi);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Task.deleteMany({});
    await Task.create([...ROWS, ...TERMINAL].map((r, i) => materialize(r, i + 1)));
  });

  it.each([...ROWS, ...TERMINAL])('$label → leaseState $leaseState', async (row) => {
    const byId = await listed();
    expect(byId.get(row.taskId).leaseState).toBe(row.leaseState);
  });

  // The differential: the field and the CAS are two expressions of one rule
  // written in different shapes (a per-row projection vs a Mongo query
  // predicate). Nothing but this test makes them move together.
  it.each(ROWS)('$label → a stranger\'s claim agrees with leaseState', async (row) => {
    const byId = await listed();
    const state = byId.get(row.taskId).leaseState;
    // Guard the guard: without this, an ABSENT field satisfies `state !== 'held'`
    // and every stranger-wins row passes against a tree that has no leaseState
    // at all — the assertion would be measuring undefined, not the rule.
    expect(['unleased', 'held', 'lapsed']).toContain(state);

    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/${row.taskId}/claim`)
      .set('x-test-user', 'stranger')
      .send({});

    const won = res.status === 200;
    expect(won).toBe(row.strangerWins);
    // For a live row the correspondence is exact in both directions.
    expect(state !== 'held').toBe(won);
  });

  // `unleased` is true of the LEASE and says nothing about availability: the CAS
  // refuses these rows outright. This pair is the whole reason the field is not
  // named `claimable`.
  it.each(TERMINAL)('$label reads unleased and is still refused', async (row) => {
    const byId = await listed();
    expect(byId.get(row.taskId).leaseState).toBe('unleased');

    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/${row.taskId}/claim`)
      .set('x-test-user', 'stranger')
      .send({});

    expect(res.status).toBe(409);
  });

  // The two-fetch shape theo depends on, pinned. Rescue asks for
  // `{ status: 'claimed' }` and assign asks for `{ status: 'pending' }`, and that
  // split is only correct while a lapsed row is INVISIBLE to the pending fetch —
  // which is the original defect, deliberately preserved. If someone later
  // fixes `?status=pending` to include lapsed rows, the rescue step starts
  // double-handling every row it just wrote and this test says so.
  it('a lapsed row is absent from ?status=pending and present under ?status=claimed', async () => {
    const pending = await request(app)
      .get(`/api/v1/tasks/${POD_ID}`)
      .query({ status: 'pending' })
      .set('x-test-user', 'stranger');
    expect(pending.status).toBe(200);
    const pendingIds = pending.body.tasks.map((t) => t.taskId);
    expect(pendingIds).toContain('TASK-001');
    expect(pendingIds).not.toContain('TASK-003');

    const claimed = await request(app)
      .get(`/api/v1/tasks/${POD_ID}`)
      .query({ status: 'claimed' })
      .set('x-test-user', 'stranger');
    expect(claimed.status).toBe(200);
    const lapsed = claimed.body.tasks.find((t) => t.taskId === 'TASK-003');
    expect(lapsed).toBeDefined();
    expect(lapsed.leaseState).toBe('lapsed');
  });

  // The branch a per-row field structurally cannot carry. If someone ever reads
  // `held` as "do not attempt", this is what breaks: a seat stops resuming the
  // task it claimed last cycle.
  it('held does not mean unclaimable — the holder renews its own live lease', async () => {
    const byId = await listed();
    expect(byId.get('TASK-002').leaseState).toBe('held');

    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/TASK-002/claim`)
      .set('x-test-user', 'holder')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.task.claimedBy).toBe('holder');
  });

  // The openclaw tool types `assignee` as a plain string and documents "empty
  // string to unassign", so a moltbot cannot send null. Stored verbatim, '' is
  // neither null nor missing, and the assign step skips the row forever.
  it.each([[null, 'an MCP/HTTP caller'], ['', 'a moltbot']])('unassign via %p (%s) lands as null', async (value) => {
    await Task.updateOne({ taskId: 'TASK-003' }, { $set: { assignee: 'deadseat' } });

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-003`)
      .set('x-test-user', 'stranger')
      .send({ status: 'pending', assignee: value });

    expect(res.status).toBe(200);
    expect(res.body.task.assignee).toBeNull();
  });

  it('a rescued row returns to the pool rather than to the dead seat\'s lane', async () => {
    // What theo's heartbeat performs on a lapsed row. Clearing the assignee is
    // the load-bearing half: status alone sends the task back to the lane of the
    // seat that died holding it, where nobody else's `assignee:<self>` fetch
    // will ever see it.
    await Task.updateOne({ taskId: 'TASK-003' }, { $set: { assignee: 'deadseat' } });

    const res = await request(app)
      .patch(`/api/v1/tasks/${POD_ID}/TASK-003`)
      .set('x-test-user', 'stranger')
      .send({ status: 'pending', assignee: null });

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('pending');
    expect(res.body.task.assignee).toBeNull();

    const byId = await listed();
    expect(byId.get('TASK-003').leaseState).toBe('unleased');
  });
});
