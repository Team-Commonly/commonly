/**
 * A conflicting write must not go through a peer's LIVE lease (AX entry 61).
 *
 * The measurement that earned this: @sprint-review claimed TASK-136 at
 * 12:15:08.569Z, and @sprint-impl completed that same row at 12:15:18.875Z —
 * ten seconds later, writing straight through the claim. The response reported
 * `status: done` beside a `claimedBy` whose lease was still thirty minutes out.
 * Cause: `/complete` filters on `status` alone, so nothing in the write ever
 * looked at the holder, and the 409 it did return was about status, never about
 * who held the row.
 *
 * The guard is deliberately NOT `claimableConditions`. Two reasons, each of
 * which is a test below rather than a comment:
 *
 *  - it has no branch for `status: 'done'`, so using it would freeze every
 *    retitle and after-the-fact prUrl on a finished row ("a DONE row is still
 *    patchable by a peer");
 *  - it refuses rows with a LAPSED lease, which would strand work behind a dead
 *    seat — the objection that kept this out of the kernel at all ("a lapsed
 *    lease does not strand the row"). A lapsed lease is claimable again by the
 *    existing CAS; recovery is lazy and discovery is the mechanism.
 *
 * What is refused is exactly: a different seat holding an unexpired lease. The
 * note-append route is deliberately left open — a note on someone else's row is
 * the coordination a claim exists to ENABLE, and for the holder it is also the
 * renewal path (#1080 part 1) — so it has its own test to keep a future edit
 * from quietly gating the audit trail.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = req.get('x-test-user') || 'holder';
  req.user = {
    id: req.userId,
    _id: req.userId,
    username: req.get('x-test-username') || undefined,
    isBot: Boolean(req.get('x-test-username')),
  };
  next();
});
// The AGENT shape, which the human mock cannot produce: agentRuntimeAuth sets
// req.agentUser and leaves req.user undefined, so `resolveAgentInstanceId`
// (which reads req.user.isBot) resolves nothing and the claim key falls back to
// the caller's id — the same derivation the claim route uses, which is why the
// comparison below is apples-to-apples.
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
        { toString: () => 'me-seat' },
        { toString: () => 'other-seat' },
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
const mockResolveTaskAttention = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordTaskAttention: (...args) => mockRecordTaskAttention(...args),
  resolveTaskAttention: (...args) => mockResolveTaskAttention(...args),
}));

const Task = require('../../../models/Task');
const tasksApi = require('../../../routes/tasksApi');

const MIN = 60 * 1000;
const LEASE_MS = 30 * MIN;

let mongod;
let app;

// `auth` dispatches on the Authorization header: a `cm_agent_*` token routes to
// agentRuntimeAuth, anything else to the human path. Without the header the
// request goes through the HUMAN mock and the seat branch is never exercised —
// which is how the first draft of a sibling suite "tested the agent shape"
// while testing the human one.
const asSeat = (r, seat) => r
  .set('Authorization', 'Bearer cm_agent_test')
  .set('x-test-user', seat)
  .set('x-test-agent-username', seat);
const asHuman = (r, person) => r.set('x-test-user', person);
// The THIRD auth shape this router serves, and the one nothing reached: a bot
// arriving through the USER path (`x-test-user` + `x-test-username`, no
// `cm_agent_` bearer). `auth` at :92 sends any non-`cm_agent_` token to
// regularAuth, so such a caller has no `req.agentUser` and its User row's
// `isBot` is the only thing marking it a seat. `x-test-username` is what the
// auth mock above turns into `isBot`, which is why sending it is the whole
// point of this helper.
const asBotJwt = (r, seat) => r.set('x-test-user', seat).set('x-test-username', seat);

const complete = (seat, { human = false } = {}) => asSeatOrHuman(
  request(app).post(`/api/v1/tasks/${POD_ID}/TASK-001/complete`).send({ prUrl: null }),
  seat,
  human,
);

const patch = (seat, body = { title: 'a better title' }, { human = false } = {}) => asSeatOrHuman(
  request(app).patch(`/api/v1/tasks/${POD_ID}/TASK-001`).send(body),
  seat,
  human,
);

const note = (seat, text = 'context for whoever holds this') => asSeat(
  request(app).post(`/api/v1/tasks/${POD_ID}/TASK-001/updates`).send({ text }),
  seat,
);

function asSeatOrHuman(r, seat, human) {
  return human ? asHuman(r, seat) : asSeat(r, seat);
}

// A row another seat is actively working: live lease, five minutes in.
const leasedByPeer = (overrides = {}) => Task.create({
  podId: POD_ID,
  taskNum: 1,
  taskId: 'TASK-001',
  title: 'decouple the schema',
  status: 'claimed',
  claimedBy: 'other-seat',
  claimedAt: new Date(Date.now() - 5 * MIN),
  claimExpiresAt: new Date(Date.now() + 25 * MIN),
  ...overrides,
});

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
  mockResolveTaskAttention.mockReset();
  mockResolveTaskAttention.mockResolvedValue(undefined);
});

describe('POST /complete refuses a peer\'s live lease', () => {
  it('a different seat is refused, and told who holds it and when it frees', async () => {
    const seed = await leasedByPeer();

    const res = await complete('me-seat');

    expect(res.status).toBe(409);
    // The fields `claim` already returns on a lost race, so a refused writer
    // learns the same two things a losing claimant does.
    expect(res.body.claimedBy).toBe('other-seat');
    expect(new Date(res.body.claimExpiresAt).getTime())
      .toBe(new Date(seed.claimExpiresAt).getTime());

    // The refusal must not be cosmetic: the row is untouched.
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('claimed');
    expect(row.claimedBy).toBe('other-seat');
    expect(row.completedAt).toBeFalsy();
    expect(row.updates || []).toHaveLength(0);
  });

  // Caught in gate by sprint-review, who measured it both ways: their M6
  // (`isSeatCaller = Boolean(req.agentUser)`, dropping `|| req.user?.isBot`)
  // left all 29 tests green while a bot-JWT caller completed straight through a
  // peer's live lease. The branch was correct and entirely unexercised — and for
  // a guard whose whole job is "a seat stands down", the untested caller class
  // is the one that fails silently.
  it('a bot-authenticated user token is a seat too', async () => {
    await leasedByPeer();

    const res = await asBotJwt(
      request(app).post(`/api/v1/tasks/${POD_ID}/TASK-001/complete`).send({ prUrl: null }),
      'me-seat',
    );

    expect(res.status).toBe(409);
    expect(res.body.claimedBy).toBe('other-seat');
  });

  it('the holder completes its own row', async () => {
    await leasedByPeer();

    const res = await complete('other-seat');

    expect(res.status).toBe(200);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.status).toBe('done');
  });

  it('a lapsed lease does not strand the row', async () => {
    // The objection this design has to survive: if refusal keyed on "a lease
    // exists", a dead claimant's row would be stuck forever. It keys on an
    // UNEXPIRED lease, so a lapsed row is writable — and claimable, by the same
    // predicate the CAS uses.
    await leasedByPeer({
      claimedAt: new Date(Date.now() - 90 * MIN),
      claimExpiresAt: new Date(Date.now() - 60 * MIN),
    });

    const res = await complete('me-seat');

    expect(res.status).toBe(200);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).status).toBe('done');
  });

  it('a legacy claim with no expiry is live, and reports a real instant', async () => {
    // Claims that predate leases carry claimExpiresAt: null and lapse one lease
    // after claimedAt (CAS branch 4). Refusing it is right; reporting a bare
    // null would tell the refused writer to retry never.
    const claimedAt = new Date(Date.now() - 5 * MIN);
    await leasedByPeer({ claimedAt, claimExpiresAt: null });

    const res = await complete('me-seat');

    expect(res.status).toBe(409);
    expect(res.body.claimExpiresAt).not.toBeNull();
    expect(new Date(res.body.claimExpiresAt).getTime())
      .toBe(claimedAt.getTime() + LEASE_MS);
  });

  it('a legacy claim older than one lease is not live', async () => {
    await leasedByPeer({
      claimedAt: new Date(Date.now() - 90 * MIN),
      claimExpiresAt: null,
    });

    expect((await complete('me-seat')).status).toBe(200);
  });

  it('an unclaimed pending row is unaffected', async () => {
    await leasedByPeer({
      status: 'pending', claimedBy: null, claimedAt: null, claimExpiresAt: null,
    });

    expect((await complete('me-seat')).status).toBe(200);
  });

  it('a missing task is still a 404, not a 500 from the guard', async () => {
    const res = await request(app)
      .post(`/api/v1/tasks/${POD_ID}/TASK-404/complete`)
      .set('Authorization', 'Bearer cm_agent_test')
      .set('x-test-user', 'me-seat')
      .set('x-test-agent-username', 'me-seat')
      .send({});
    expect(res.status).toBe(404);
  });

  it('a PERSON is never refused — a lease is seat coordination, not authority', async () => {
    await leasedByPeer();

    const res = await complete('holder', { human: true });

    expect(res.status).toBe(200);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).status).toBe('done');
  });
});

describe('PATCH is guarded the same way', () => {
  it('a peer cannot retitle a row under a live lease', async () => {
    await leasedByPeer();

    const res = await patch('me-seat');

    expect(res.status).toBe(409);
    expect(res.body.claimedBy).toBe('other-seat');
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.title).toBe('decouple the schema');
  });

  it('the holder can retitle its own row', async () => {
    await leasedByPeer();

    expect((await patch('other-seat')).status).toBe(200);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).title).toBe('a better title');
  });

  it('a DONE row stays patchable by a peer', async () => {
    // The reason the guard is the lease LABEL and not `claimableConditions`:
    // that predicate has no branch for `status: 'done'`, so a claimability
    // guard would have frozen every finished row against a retitle or an
    // after-the-fact prUrl — the exact correction this repo has had to make
    // four times on one row.
    await leasedByPeer({
      status: 'done',
      completedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 25 * MIN),
    });

    const res = await patch('me-seat', { prUrl: 'https://example.test/pr/1' });

    expect(res.status).toBe(200);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.prUrl).toBe('https://example.test/pr/1');
  });

  it('a person can still correct a peer\'s leased row', async () => {
    await leasedByPeer();

    expect((await patch('holder', { assignee: 'me-seat' }, { human: true })).status).toBe(200);
  });
});

describe('the refusal performs no side effect, which is how it composes with #1767', () => {
  // #1767 (merged) made `/complete` close the done task's outstanding handoff
  // cards. These two changes touch the same handler, so it is worth pinning that
  // they compose rather than merely coexist: the refusal returns before that
  // line, so a write that never happened cannot close a card. Mutating the guard
  // to return AFTER the write would red the first case.
  it('a refused completion closes no handoff cards', async () => {
    await leasedByPeer();

    const res = await complete('me-seat');

    expect(res.status).toBe(409);
    expect(mockResolveTaskAttention).not.toHaveBeenCalled();
  });

  it('an allowed completion still closes them', async () => {
    await leasedByPeer({
      status: 'pending', claimedBy: null, claimedAt: null, claimExpiresAt: null,
    });

    expect((await complete('me-seat')).status).toBe(200);
    expect(mockResolveTaskAttention).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'TASK-001' }),
    );
  });
});

describe('the note-append route is deliberately NOT gated', () => {
  it('a peer\'s note on a leased row still lands', async () => {
    // Gating this would remove the one signal a peer can add to someone else's
    // row, and for the holder it is the renewal path itself. The existing
    // handler already draws the line correctly: the note lands either way, only
    // the lease extension is holder-gated.
    const before = await leasedByPeer();

    const res = await note('me-seat', 'saw the TASK-024 retitle question — answered in #1767');

    expect(res.status).toBe(200);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect((row.updates || []).map((u) => u.text))
      .toContain('saw the TASK-024 retitle question — answered in #1767');
    // And still no lease transfer.
    expect(new Date(row.claimExpiresAt).getTime())
      .toBe(new Date(before.claimExpiresAt).getTime());
    expect(row.claimedBy).toBe('other-seat');
  });
});
