/**
 * F669: "N turns today · M in the last 7 days" on a person's own agent, for its owner
 * only. A turn is one spawn the agent's runner reported (each one runs on the
 * owner's own Claude or Codex account), counted by the owner's local day, with
 * a per-pod breakdown. Real models on memory Mongo; only auth is stubbed.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
  req.userId = id;
  return next();
});

const { turnCounts } = require('../../../services/agentTurnCountService');

const OWNER = new mongoose.Types.ObjectId();
const FRIEND = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();
const BOT = new mongoose.Types.ObjectId();
const OWN_POD = new mongoose.Types.ObjectId();
const SHARED_POD = new mongoose.Types.ObjectId();
const HIDDEN_POD = new mongoose.Types.ObjectId();
const MACHINE = 'turns-machine';
// 02:00 on 26 Nov in Los Angeles, 10:00 the same day in UTC.
const NOW = new Date('2026-11-26T10:00:00Z');
const at = (iso) => new Date(iso);

describe('turnCounts', () => {
  const turns = [
    { podId: 'p1', at: at('2026-11-26T07:30:00Z') }, // 25 Nov 23:30 in LA: yesterday there, today in UTC
    { podId: 'p1', at: at('2026-11-26T08:30:00Z') }, // 26 Nov 00:30 in LA: today
    { podId: 'p2', at: at('2026-11-20T08:30:00Z') }, // 20 Nov 00:30 in LA: the first of the last 7 days
    { podId: 'p2', at: at('2026-11-20T07:30:00Z') }, // 19 Nov 23:30 in LA: outside the 7 days there, inside in UTC
    { podId: null, at: at('2026-11-26T09:59:00Z') }, // a runner that sent no pod: today
  ];

  test('buckets turns by the owner\'s local day across a time zone boundary', () => {
    const la = turnCounts(turns, 'America/Los_Angeles', NOW);
    expect([la.today, la.week]).toEqual([2, 4]);
    const utc = turnCounts(turns, 'UTC', NOW);
    expect([utc.today, utc.week]).toEqual([3, 5]);
  });

  test('the per-pod breakdown sums to the total', () => {
    const { today, week, pods } = turnCounts(turns, 'America/Los_Angeles', NOW);
    expect(pods).toEqual(expect.arrayContaining([
      { podId: 'p1', today: 1, week: 2 }, { podId: 'p2', today: 0, week: 1 }, { podId: null, today: 1, week: 1 },
    ]));
    expect(pods.reduce((sum, pod) => sum + pod.today, 0)).toBe(today);
    expect(pods.reduce((sum, pod) => sum + pod.week, 0)).toBe(week);
  });

  // The stored list keeps the newest RECENT_TURN_LIMIT turns. When it is full and
  // its oldest turn is still inside the 7 days, older ones in the window are gone.
  test('a full list whose oldest turn is inside the 7 days says the count is capped', () => {
    const { RECENT_TURN_LIMIT } = require('../../../models/AgentRuntimeObservation');
    const recent = Array.from({ length: RECENT_TURN_LIMIT }, () => ({ podId: 'p1', at: at('2026-11-25T12:00:00Z') }));
    const full = turnCounts(recent, 'UTC', NOW);
    expect(full).toEqual(expect.objectContaining({ week: RECENT_TURN_LIMIT, weekCapped: true }));
    const olderFirst = [{ podId: 'p1', at: at('2026-11-01T12:00:00Z') }, ...recent.slice(1)];
    expect(turnCounts(olderFirst, 'UTC', NOW).weekCapped).toBe(false);
    expect(turnCounts(recent.slice(1), 'UTC', NOW).weekCapped).toBe(false);
  });
});

describe('GET /api/registry/agents/:name/turns', () => {
  let mongod;
  let app;
  let Observation;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    const User = require('../../../models/User');
    const Pod = require('../../../models/Pod');
    const Machine = require('../../../models/Machine');
    const { AgentInstallation } = require('../../../models/AgentRegistry');
    Observation = require('../../../models/AgentRuntimeObservation');
    await User.create([
      { _id: OWNER, username: 'owner', email: 'owner@test.invalid', password: 'pw', timezone: 'America/Los_Angeles' },
      { _id: FRIEND, username: 'friend', email: 'friend@test.invalid', password: 'pw' },
      { _id: ADMIN, username: 'admin', email: 'admin@test.invalid', password: 'pw', role: 'admin' },
      { _id: BOT, username: 'my-agent', email: 'bot@test.invalid', password: 'pw', isBot: true,
        botMetadata: { agentName: 'my-agent', instanceId: 'default', machineId: MACHINE, ownerUserId: OWNER } },
    ]);
    await Machine.create({ ownerUserId: OWNER, machineId: MACHINE, name: 'laptop' });
    await Pod.create([
      { _id: OWN_POD, name: 'Notes', type: 'chat', createdBy: OWNER, members: [OWNER, BOT] },
      { _id: SHARED_POD, name: 'Team', type: 'chat', createdBy: FRIEND, members: [FRIEND, OWNER, BOT] },
      // Someone else's pod the agent was added to: the owner can't see it.
      { _id: HIDDEN_POD, name: 'Private', type: 'chat', createdBy: FRIEND, members: [FRIEND, BOT] },
    ]);
    await AgentInstallation.create([OWN_POD, SHARED_POD, HIDDEN_POD].map((podId) => ({
      agentName: 'my-agent', instanceId: 'default', podId, version: '1', installedBy: OWNER, status: 'active',
    })));
    app = express();
    app.use(express.json());
    app.use('/api/registry', require('../../../routes/registry/agent-turns'));
  });

  beforeEach(async () => {
    // Only the clock is fixed; the driver's timers keep running.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval',
        'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    await Observation.deleteMany({});
    await Observation.create({
      agentUserId: BOT, machineId: MACHINE, connectedAt: NOW, lastSeenAt: NOW,
      recentTurns: [
        { podId: String(OWN_POD), at: at('2026-11-26T08:30:00Z') },
        { podId: String(OWN_POD), at: at('2026-11-26T07:30:00Z') },
        { podId: String(SHARED_POD), at: at('2026-11-26T09:00:00Z') },
        { podId: String(HIDDEN_POD), at: at('2026-11-24T09:00:00Z') },
        { podId: null, at: at('2026-11-23T09:00:00Z') },
      ],
    });
  });

  afterEach(() => jest.useRealTimers());

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  test('the owner reads today and the last 7 days in their own time zone, broken down by pod', async () => {
    const res = await request(app).get('/api/registry/agents/my-agent/turns?instanceId=default')
      .set('x-test-user', String(OWNER));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      timeZone: 'America/Los_Angeles', today: 2, week: 5, weekCapped: false,
    }));
    expect(res.body.pods).toEqual(expect.arrayContaining([
      { podId: String(OWN_POD), podName: 'Notes', podType: 'chat', today: 1, week: 2 },
      { podId: String(SHARED_POD), podName: 'Team', podType: 'chat', today: 1, week: 1 },
    ]));
    // A pod the owner can't see is counted but never named, with the turns no pod was reported for.
    expect(res.body.elsewhere).toEqual({ today: 0, week: 2 });
    expect(JSON.stringify(res.body)).not.toContain(String(HIDDEN_POD));
    const podSum = res.body.pods.reduce((sum, pod) => sum + pod.week, 0) + res.body.elsewhere.week;
    expect(podSum).toBe(res.body.week);
  });

  test.each([['a member of the agent\'s pods', FRIEND], ['an admin', ADMIN]])(
    '%s who is not the owner gets a 404 and no counts', async (_label, viewer) => {
      const res = await request(app).get('/api/registry/agents/my-agent/turns?instanceId=default')
        .set('x-test-user', String(viewer));
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('today');
    },
  );

  test('a machine owner who no longer owns the agent gets a 404', async () => {
    const { AgentInstallation } = require('../../../models/AgentRegistry');
    // Someone else now holds the agent's install in the shared pod, so the
    // machine's owner no longer owns its identity.
    const filter = { agentName: 'my-agent', instanceId: 'default', podId: SHARED_POD };
    await AgentInstallation.updateOne(filter, { installedBy: FRIEND });
    try {
      const res = await request(app).get('/api/registry/agents/my-agent/turns').set('x-test-user', String(OWNER));
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('today');
    } finally {
      await AgentInstallation.updateOne(filter, { installedBy: OWNER });
    }
  });

  test('an agent nobody runs on a computer reads as not found', async () => {
    const res = await request(app).get('/api/registry/agents/nobody/turns').set('x-test-user', String(OWNER));
    expect(res.status).toBe(404);
  });

  test('a runner that has reported nothing reads as zero', async () => {
    await Observation.deleteMany({});
    const res = await request(app).get('/api/registry/agents/my-agent/turns').set('x-test-user', String(OWNER));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      today: 0, week: 0, pods: [], elsewhere: { today: 0, week: 0 },
    }));
  });
});
