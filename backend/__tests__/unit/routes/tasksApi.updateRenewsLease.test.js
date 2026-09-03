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
  // A separate USERNAME header, because the whole point of the shape tests
  // below is that a caller's id and their username are different strings and
  // `lapsedFrom` may hold either. The original fixture set them equal, which
  // is exactly why it passed against a filter that only matched one.
  req.user = {
    id: req.userId,
    _id: req.userId,
    username: req.get('x-test-username') || undefined,
    isBot: Boolean(req.get('x-test-username')),
  };
  next();
});
// The AGENT shape, which the human auth mock above cannot produce:
// agentRuntimeAuth sets req.agentUser and leaves req.user undefined. Every
// previous test in this file went through the human mock, which is why two
// rounds of "fix" shipped without anyone noticing the agent path resolved
// nothing.
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  const asAgent = req.get('x-test-agent-username');
  if (asAgent) {
    req.userId = req.get('x-test-user');
    req.user = undefined;
    req.agentUser = {
      _id: req.get('x-test-user'),
      username: asAgent,
      botMetadata: { agentName: asAgent, instanceId: 'default' },
    };
  }
  next();
});

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({
      type: 'chat',
      members: [
        { toString: () => 'holder' },
        { toString: () => 'stranger' },
        // Distinct id/username pair for the lapsedFrom shape tests below — the
        // point of those is that the two strings differ, so both must be able
        // to reach the handler rather than 403 at membership.
        { toString: () => '6a693bfbe833c668acdce53b' },
        { toString: () => 'someone-else-id' },
        { toString: () => 'some-other-bot-id' },
      ],
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
const mockRecordTaskAttention = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordTaskAttention: (...args) => mockRecordTaskAttention(...args),
}));

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

beforeEach(async () => {
  await Task.deleteMany({});
  mockRecordTaskAttention.mockReset();
  mockRecordTaskAttention.mockResolvedValue(undefined);
});

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

  it('hands every progress note to the task-attention source writer', async () => {
    await seed({ claimedBy: 'holder', claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + LEASE_MS) });

    const res = await postUpdate('holder', 'TASK-001', 'Ready for Sam\'s ruling.');

    expect(res.status).toBe(200);
    expect(mockRecordTaskAttention).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'TASK-001',
      updates: expect.arrayContaining([expect.objectContaining({ text: 'Ready for Sam\'s ruling.' })]),
    }));
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

describe('a holder-authored note resets the deferral budget too', () => {
  // Found by @sprint-review after #1082 shipped (pod 56544). Part 1 renewed
  // the lease and part 2 counted deferrals, and the two never met: a holder
  // renewing by notes extended the lease forever while the budget ticked down
  // and never reset, so the kernel eventually rescued them for following its
  // own cue. Observed live on TASK-025 before the fix — note at 04:35:54
  // moved claimExpiresAt to 05:05:54 with rescueDeferrals stuck at 1.

  it('the holder\'s note zeroes rescueDeferrals, like a re-claim does', async () => {
    await seed({
      claimedBy: 'holder',
      claimedAt: new Date(Date.now() - 25 * MIN),
      claimExpiresAt: new Date(Date.now() + 5 * MIN),
      rescueDeferrals: 2,
    });

    await postUpdate('holder', 'TASK-001', 'still on it');

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.rescueDeferrals).toBe(0);
  });

  it('a peer\'s note does NOT reset it — same gate as the lease', async () => {
    await seed({
      claimedBy: 'holder',
      claimedAt: new Date(Date.now() - 25 * MIN),
      claimExpiresAt: new Date(Date.now() + 5 * MIN),
      rescueDeferrals: 2,
    });

    await postUpdate('stranger', 'TASK-001', 'passing comment');

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    // A passing peer must not top up someone else's budget any more than
    // they may extend someone else's lease.
    expect(row.rescueDeferrals).toBe(2);
  });

  it('renewal and budget move together — the property that was missing', async () => {
    const before = new Date(Date.now() + 5 * MIN);
    await seed({
      claimedBy: 'holder',
      claimedAt: new Date(Date.now() - 25 * MIN),
      claimExpiresAt: before,
      rescueDeferrals: 3,
    });

    await postUpdate('holder', 'TASK-001', 'progress');

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    // Both or neither. A renewal that moves one and not the other is exactly
    // the shipped bug, and asserting them jointly is what pins the pairing.
    expect(new Date(row.claimExpiresAt).getTime()).toBeGreaterThan(before.getTime());
    expect(row.rescueDeferrals).toBe(0);
  });

  it('an already-lapsed holder recovers the full budget by writing a note', async () => {
    await seed({
      claimedBy: 'holder',
      claimedAt: new Date(Date.now() - 90 * MIN),
      claimExpiresAt: new Date(Date.now() - 60 * MIN),
      rescueDeferrals: 2,
    });

    await postUpdate('holder', 'TASK-001', 'back on it');

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(new Date(row.claimExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(row.rescueDeferrals).toBe(0);
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

/**
 * The sweep-race half, found live on TASK-029 (2026-08-22).
 *
 * The deferral warning says "post a task update or re-claim — either renews
 * the lease". Those two were NOT equivalent: the renewing filter requires
 * `status: 'claimed'`, so once the sweep returned the row to `pending` a note
 * fell through to the note-only path — 200, note recorded, no lease, and no
 * way for the caller to tell.
 *
 * Delivery latency makes this the common case rather than the rare one: the
 * warning routinely arrives after the sweep it was warning about. On TASK-029
 * the warning was written at 12:24 and the note landed at 12:56, two minutes
 * after the 12:54 sweep.
 */
describe('POST /updates after the sweep has already taken the row', () => {
  it('the lapsed holder\'s note restores their claim', async () => {
    await seed({
      status: 'pending', claimedBy: null, claimedAt: null, claimExpiresAt: null,
      lapsedFrom: 'holder', rescueDeferrals: 3,
    });

    const res = await postUpdate('holder', 'TASK-001', 'still mine, 2 of 4 shipped');
    expect(res.status).toBe(200);
    expect(res.body.leaseRenewed).toBe(true);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('claimed');
    expect(row.claimedBy).toBe('holder');
    expect(new Date(row.claimExpiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * MIN);
    // The budget resets with the lease, same as #1096 — a restored claim that
    // kept a spent budget would be swept again within one orbit.
    expect(row.rescueDeferrals).toBe(0);
    expect(row.lapsedFrom).toBeNull();
    expect(row.updates.map((u) => u.text)).toContain('still mine, 2 of 4 shipped');
  });

  it('but NOT if a peer won the race — the board beat them to it', async () => {
    // This is the case that makes returning the row to the board mean anything.
    await seed({
      status: 'claimed', claimedBy: 'stranger', claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + LEASE_MS), lapsedFrom: 'holder',
    });

    const res = await postUpdate('holder', 'TASK-001', 'picking this back up');
    expect(res.status).toBe(200);
    expect(res.body.leaseRenewed).toBe(false);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.claimedBy).toBe('stranger');
    // The note still lands. Gating the lease must never gate the audit trail.
    expect(row.updates.map((u) => u.text)).toContain('picking this back up');
  });

  it('and NOT for a seat the row was never taken from', async () => {
    // lapsedFrom names one seat. Without that filter, any peer could convert a
    // pending row into their own claim by writing a note — which is a claim
    // without the claim endpoint's rate limit or its atomicity contract.
    await seed({
      status: 'pending', claimedBy: null, claimedAt: null, claimExpiresAt: null,
      lapsedFrom: 'holder',
    });

    const res = await postUpdate('stranger', 'TASK-001', 'drive-by note');
    expect(res.status).toBe(200);
    expect(res.body.leaseRenewed).toBe(false);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('pending');
    expect(row.claimedBy).toBeFalsy();
    expect(row.updates.map((u) => u.text)).toContain('drive-by note');
  });

  it('a pending row with no lapsedFrom is claimable by nobody via a note', async () => {
    // A never-claimed row. `lapsedFrom: null` must not match a caller whose
    // claimKey is also falsy — the filter has to require a real match.
    await seed({ status: 'pending', claimedBy: null, claimExpiresAt: null, lapsedFrom: null });

    const res = await postUpdate('holder', 'TASK-001', 'thoughts on this one');
    expect(res.status).toBe(200);
    expect(res.body.leaseRenewed).toBe(false);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('pending');
    expect(row.updates.map((u) => u.text)).toContain('thoughts on this one');
  });

  it('the holder path still reports leaseRenewed on an ordinary renewal', async () => {
    const claimedAt = new Date(Date.now() - 25 * MIN);
    await seed({ claimedBy: 'holder', claimedAt, claimExpiresAt: new Date(claimedAt.getTime() + LEASE_MS) });

    const res = await postUpdate('holder', 'TASK-001', 'progress');
    expect(res.body.leaseRenewed).toBe(true);
  });
});

/**
 * `lapsedFrom` is polymorphic, and matching one shape is matching none.
 *
 * The sweep writes `provenance = holder?.label || t.assignee || t.claimedBy`,
 * where `label` is itself `assignee || holder?.username || claimedBy`. So the
 * field holds an assignee NAME, a bot USERNAME, or a User ObjectId string.
 *
 * The first restore filter matched `lapsedFrom: claimKey` — the id — and the
 * tests passed because the fixture set lapsedFrom to the SAME value it sent as
 * the caller. Live on TASK-029 the field held "pod-architect" while claimedBy
 * had been an ObjectId, so the restore silently never fired.
 */
describe('the restore matches every shape lapsedFrom can hold', () => {
  const postAs = (userId, username, text = 'still mine') => request(app)
    .post(`/api/v1/tasks/${POD_ID}/TASK-001/updates`)
    .set('x-test-user', userId)
    .set('x-test-username', username)
    .send({ text });

  it('restores when lapsedFrom holds the USERNAME and the caller authed by id', async () => {
    // The live case. These two strings are different and must both resolve to
    // the same seat.
    await seed({
      status: 'pending', claimedBy: null, claimExpiresAt: null,
      lapsedFrom: 'pod-architect',
    });

    const res = await postAs('6a693bfbe833c668acdce53b', 'pod-architect');
    expect(res.body.leaseRenewed).toBe(true);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('claimed');
    expect(row.claimedBy).toBe('6a693bfbe833c668acdce53b');
    expect(row.lapsedFrom).toBeNull();
  });

  it('restores when lapsedFrom holds the ID', async () => {
    // The shape the original filter handled. Kept so the widening is additive.
    await seed({
      status: 'pending', claimedBy: null, claimExpiresAt: null,
      lapsedFrom: '6a693bfbe833c668acdce53b',
    });
    const res = await postAs('6a693bfbe833c668acdce53b', 'pod-architect');
    expect(res.body.leaseRenewed).toBe(true);
  });

  it('does NOT restore for a seat whose username merely resembles nothing', async () => {
    // Widening must not become "any caller restores any lapsed row".
    await seed({
      status: 'pending', claimedBy: null, claimExpiresAt: null,
      lapsedFrom: 'pod-architect',
    });
    const res = await postAs('someone-else-id', 'ux-lead');
    expect(res.body.leaseRenewed).toBe(false);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('pending');
    expect(row.updates.map((u) => u.text)).toContain('still mine');
  });

  it('does NOT restore a row with no lapsedFrom, even for a caller with no username', async () => {
    // The empty-matches-empty hazard: a filter built from a list must never
    // let undefined match null.
    await seed({ status: 'pending', claimedBy: null, claimExpiresAt: null, lapsedFrom: null });
    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/TASK-001/updates`)
      .set('x-test-user', 'holder')
      .send({ text: 'drive-by' });
    expect(res.body.leaseRenewed).toBe(false);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).status).toBe('pending');
  });
});

describe('the AGENT request shape resolves too', () => {
  // agentRuntimeAuth sets req.agentUser and NOT req.user. #1124 widened the
  // identity list but read three of its four new fields off req.user, so for
  // an MCP-authenticated agent it still collected only the ObjectId — the
  // state before the widening. Confirmed live: TASK-029 returned
  // leaseRenewed:false both before and after #1124 deployed.
  // tasksApi's own `auth` dispatches on the Authorization header: a
  // `cm_agent_*` token routes to agentRuntimeAuth, anything else to the human
  // path. Without this header the request goes through the HUMAN mock and the
  // agent branch is never exercised — which is how the first draft of these
  // tests "passed the agent shape" while testing the human one.
  const postAsAgent = (userId, agentUsername, text = 'still mine') => request(app)
    .post(`/api/v1/tasks/${POD_ID}/TASK-001/updates`)
    .set('Authorization', 'Bearer cm_agent_test')
    .set('x-test-user', userId)
    .set('x-test-agent-username', agentUsername)
    .send({ text });

  it('restores when lapsedFrom holds the bot USERNAME and the caller is an agent', async () => {
    // The live case, exactly: lapsedFrom is the username the sweep took from
    // holder.username, and the caller authenticates with an ObjectId.
    await seed({
      status: 'pending', claimedBy: null, claimExpiresAt: null,
      lapsedFrom: 'pod-architect',
    });

    const res = await postAsAgent('6a693bfbe833c668acdce53b', 'pod-architect');
    expect(res.body.leaseRenewed).toBe(true);

    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('claimed');
    expect(row.lapsedFrom).toBeNull();
  });

  it('and when lapsedFrom holds the agentName', async () => {
    await seed({
      status: 'pending', claimedBy: null, claimExpiresAt: null, lapsedFrom: 'pod-architect',
    });
    const res = await postAsAgent('6a693bfbe833c668acdce53b', 'pod-architect');
    expect(res.body.leaseRenewed).toBe(true);
  });

  it('but NOT for a different agent', async () => {
    // Widening must not become "any agent restores any lapsed row".
    await seed({
      status: 'pending', claimedBy: null, claimExpiresAt: null, lapsedFrom: 'pod-architect',
    });
    const res = await postAsAgent('some-other-bot-id', 'ux-lead');
    expect(res.body.leaseRenewed).toBe(false);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).status).toBe('pending');
  });
});
