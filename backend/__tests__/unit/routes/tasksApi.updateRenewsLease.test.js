/**
 * A holder-authored task update renews the lease (#1080 part 1).
 *
 * Fable's ruling, verbatim: "renewal derives from work — any holder-authored
 * task update renews the lease, kernel-side."
 *
 * The measurement that earned it (@sprint-review, 56203): @sprint-impl wrote a
 * progress note on TASK-015 at 09:27:30 and the lease still lapsed at 09:51:11.
 * The one signal a working holder naturally produces is exactly the one the
 * lease ignored — so the row was rescued, its assignee cleared, and the board
 * re-advertised work whose PR was already open.
 *
 * Real in-memory Mongo, not a mocked model: the holder match lives in the
 * findOneAndUpdate FILTER, so it is Mongo that decides whether the renewing
 * form applies. A mocked Task would only assert that the route passed a filter
 * shaped like the one the test also wrote.
 *
 * The invariant that must never regress is the SECOND half of each case: the
 * note lands either way. Gating the lease must never gate the audit trail.
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

const postUpdate = (as, taskId, text = 'rebased onto #1055') => request(app)
  .post(`/api/v1/tasks/${POD_ID}/${taskId}/updates`)
  .set('x-test-user', as)
  .send({ text });

const seed = (overrides) => Task.create({
  podId: POD_ID,
  taskNum: 1,
  taskId: 'TASK-001',
  title: 'decouple the schema',
  status: 'claimed',
  ...overrides,
});

// File-level, not per-describe: the second describe below would otherwise run
// after the first one's afterAll had already disconnected mongoose.
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

beforeEach(async () => { await Task.deleteMany({}); });

describe('POST /updates renews a holder-authored lease', () => {
  it('the holder\'s note pushes the lease out by a full period', async () => {
    const claimedAt = new Date(Date.now() - 25 * MIN);
    const before = new Date(claimedAt.getTime() + LEASE_MS);
    await seed({ claimedBy: 'holder', claimedAt, claimExpiresAt: before });

    const res = await postUpdate('holder', 'TASK-001');
    expect(res.status).toBe(200);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(new Date(row.claimExpiresAt).getTime()).toBeGreaterThan(before.getTime());
    // A full period from NOW, not a nudge from the old expiry — a renewing
    // holder must get the same lease a re-claim would have given them.
    expect(new Date(row.claimExpiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * MIN);
    expect(row.updates.map((u) => u.text)).toContain('rebased onto #1055');
  });

  it('a peer\'s note is recorded and does NOT renew', async () => {
    const claimedAt = new Date(Date.now() - 25 * MIN);
    const before = new Date(claimedAt.getTime() + LEASE_MS);
    await seed({ claimedBy: 'holder', claimedAt, claimExpiresAt: before });

    const res = await postUpdate('stranger', 'TASK-001', 'reviewed at 9f91b9b0');
    expect(res.status).toBe(200);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    // Any passing peer could otherwise keep a dead seat's claim alive forever,
    // which is the abandonment bar the lease exists to enforce.
    expect(new Date(row.claimExpiresAt).getTime()).toBe(before.getTime());
    expect(row.updates.map((u) => u.text)).toContain('reviewed at 9f91b9b0');
  });

  it('an ALREADY-LAPSED holder still renews — the row was theirs and they are working', async () => {
    const claimedAt = new Date(Date.now() - 90 * MIN);
    const before = new Date(claimedAt.getTime() + LEASE_MS);
    await seed({ claimedBy: 'holder', claimedAt, claimExpiresAt: before });
    expect(before.getTime()).toBeLessThan(Date.now());

    await postUpdate('holder', 'TASK-001');

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    // The renewing filter matches on status+claimedBy, deliberately NOT on
    // "lease still live". A holder whose lease lapsed while they worked is the
    // exact population this rule exists for; requiring a live lease would make
    // renewal available only to seats that did not need it.
    expect(new Date(row.claimExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('a note on a pending row is recorded and creates no lease', async () => {
    await seed({
      status: 'pending', claimedBy: null, claimedAt: null, claimExpiresAt: null, 
    });

    const res = await postUpdate('holder', 'TASK-001', 'blocked on openclaw#12');
    expect(res.status).toBe(200);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('pending');
    expect(row.claimExpiresAt).toBeNull();
    expect(row.updates.map((u) => u.text)).toContain('blocked on openclaw#12');
  });

  it('a note on a DONE row is recorded and does not resurrect a lease', async () => {
    await seed({
      status: 'done', claimedBy: 'holder', claimedAt: new Date(), claimExpiresAt: null, completedAt: new Date(),
    });

    await postUpdate('holder', 'TASK-001', 'follow-up filed');

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('done');
    expect(row.claimExpiresAt).toBeNull();
    expect(row.updates.map((u) => u.text)).toContain('follow-up filed');
  });

  it('a missing task is still a 404 through the two-attempt path', async () => {
    const res = await postUpdate('holder', 'TASK-404');
    expect(res.status).toBe(404);
  });

  it('an empty note is still rejected before either write', async () => {
    await seed({ claimedBy: 'holder', claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + LEASE_MS) });
    const res = await postUpdate('holder', 'TASK-001', '   ');
    expect(res.status).toBe(400);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.updates).toHaveLength(0);
  });
});

describe('claim resets the per-lease rescue budget', () => {
  it('a fresh claim zeroes rescueDeferrals and clears lapsedFrom', async () => {
    await seed({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      rescueDeferrals: 3,
      lapsedFrom: 'sprint-impl',
    });

    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/TASK-001/claim`)
      .set('x-test-user', 'stranger')
      .send({});
    expect(res.status).toBe(200);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    // The budget is per-LEASE. Without the reset, the third holder of a hot
    // task inherits a spent budget and gets rescued on their first lapse.
    expect(row.rescueDeferrals).toBe(0);
    expect(row.lapsedFrom).toBeNull();
  });
});
