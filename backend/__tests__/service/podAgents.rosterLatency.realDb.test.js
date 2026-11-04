// TASK-774. Between 20:14 and 20:35Z on 11-04 prod answered 41 GETs of
// /api/registry/pods/:podId/agents with 504: nginx's 5 s upstream limit, on one
// healthy replica, under a crawl that loads one pod after another.
//
// The roster's "last heartbeat" read asked AgentEvent for every delivered
// event of these seats with type 'heartbeat', across every pod they sit in,
// sorted them all and kept the newest per seat. `type` was in no index, so
// Mongo fetched every delivered event of every type (mentions, board events,
// messages) for those seats from the last 7 days, the GC's retention, just
// to throw away all but one per seat. It ran twice per request (the route,
// and again inside collectPodAgentActivity), and the activity read did the
// same over the pod's whole AgentRun history. Cost grew with how busy the
// seats were everywhere, not with how many agents the pod has.
//
// Measured here on Mongo 7 for a 25-seat pod: 50k delivered events gave a
// 114 ms roster, 333k gave 1.76 s, and the aggregate alone went 59 ms →
// 899 ms. It now reads one index entry per seat.
//
// Real Mongo and real Postgres (the Tier 1 job). The structural assertion
// reads what Mongo itself says it examined (the profiler), so it does not
// depend on the runner's speed; the burst is the timed check.
/* eslint-disable global-require -- models load after setupMongoDb connects */
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const {
  setupMongoDb, closeMongoDb, setupPgDb, closePgDb, 
} = require('../utils/testUtils');

const mockViewer = { id: new mongoose.Types.ObjectId().toString() };
jest.mock('../../middleware/auth', () => {
  const auth = (req, _res, next) => {
    req.userId = mockViewer.id;
    req.user = { id: mockViewer.id };
    next();
  };
  auth.touchLastActive = () => {};
  return auth;
});

const d = process.env.INTEGRATION_TEST === 'true' && process.env.PG_HOST ? describe : describe.skip;

const SEATS = 25;
const OTHER_PODS = 9; // every seat also sits in nine other pods
const EVENTS_PER_SEAT = 20000; // one week of them, across all ten pods
const RUNS_PER_SEAT = 1000;
const POD_MESSAGES = 20000;
const BURST = 10; // a page that loads the roster once per pod, all at once
const BURST_BUDGET_MS = 2000; // nginx gives up at 5000
const pad = 'x'.repeat(200);

d('a busy pod\'s roster (real Mongo + Postgres)', () => {
  let app;
  let pod;

  beforeAll(async () => {
    await setupMongoDb();
    await setupPgDb();
    const Pod = require('../../models/Pod');
    const { AgentInstallation } = require('../../models/AgentRegistry');
    const AgentEvent = require('../../models/AgentEvent');
    const AgentRun = require('../../models/AgentRun');
    const User = require('../../models/User');
    // setupMongoDb drops the database, and with it the declared indexes.
    await Promise.all([AgentInstallation, AgentEvent, AgentRun].map((m) => m.createIndexes()));
    app = express();
    app.use(express.json());
    app.use('/api/registry', require('../../routes/registry/pod-agents'));

    const seatNames = Array.from({ length: SEATS }, (_, i) => `seat-${i}`);
    const users = await User.insertMany(seatNames.map((n) => ({
      username: n,
      email: `${n}@agents.test`,
      password: 'x'.repeat(20),
      isBot: true,
      botMetadata: { agentName: n, instanceId: 'default', displayName: n },
    })));
    const members = [mockViewer.id, ...users.map((u) => u._id)];
    pod = await Pod.create({
      name: 'Busy pod', type: 'team', createdBy: mockViewer.id, members, 
    });
    const others = await Pod.insertMany(Array.from({ length: OTHER_PODS }, (_, i) => ({
      name: `Other ${i}`, type: 'team', createdBy: mockViewer.id, members,
    })));
    const podIds = [pod._id, ...others.map((p) => p._id)];
    await AgentInstallation.insertMany(podIds.flatMap((p) => seatNames.map((n) => ({
      agentName: n, instanceId: 'default', podId: p, installedBy: mockViewer.id, status: 'active', version: '1.0.0',
    }))));

    const now = Date.now();
    const week = 7 * 24 * 3600 * 1000;
    // One in ten is a heartbeat; a third are acked, the rest still delivered.
    const types = ['heartbeat', 'chat.mention', 'message.posted', 'task.updated', 'message.posted',
      'message.posted', 'chat.mention', 'message.posted', 'task.updated', 'message.posted'];
    const insertBatched = async (collection, total, make) => {
      for (let start = 0; start < total; start += 10000) {
        const docs = [];
        for (let k = start; k < Math.min(total, start + 10000); k += 1) docs.push(make(k));
        // eslint-disable-next-line no-await-in-loop
        await collection.insertMany(docs, { ordered: false });
      }
    };
    await insertBatched(AgentEvent.collection, SEATS * EVENTS_PER_SEAT, (k) => {
      const seq = Math.floor(k / SEATS);
      const createdAt = new Date(now - Math.floor((seq / EVENTS_PER_SEAT) * week));
      return {
        agentName: seatNames[k % SEATS],
        instanceId: 'default',
        podId: podIds[seq % podIds.length],
        type: types[seq % types.length],
        status: seq % 3 === 0 ? 'acked' : 'delivered',
        deliveryMode: 'wake',
        payload: { content: pad },
        createdAt,
        updatedAt: createdAt,
      };
    });
    await insertBatched(AgentRun.collection, SEATS * RUNS_PER_SEAT, (k) => {
      const startedAt = new Date(now - Math.floor(k / SEATS) * 60000);
      return {
        podId: pod._id,
        agentName: seatNames[k % SEATS],
        instanceId: 'default',
        trigger: 'mention',
        status: 'succeeded',
        turns: [{ turnIndex: 0, model: 'm', text: pad }],
        startedAt,
        createdAt: startedAt,
      };
    });

    const { pool } = require('../../config/db-pg');
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'Busy pod', 'team', $2)", [String(pod._id), mockViewer.id]);
    await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, message_type, created_at)
       SELECT $1, ($2::text[])[1 + (g % array_length($2::text[], 1))], repeat('y', 500), 'text',
              now() - (g || ' seconds')::interval
       FROM generate_series(1, $3) AS g`,
      [String(pod._id), users.map((u) => String(u._id)), POD_MESSAGES],
    );
    await pool.query('ANALYZE messages');
  }, 240000);

  afterAll(async () => {
    const { pool } = require('../../config/db-pg');
    await pool.query('TRUNCATE TABLE messages, pods RESTART IDENTITY CASCADE');
    await closePgDb();
    await pool.end();
    await closeMongoDb();
  });

  test('it examines a few index entries per seat, not the seats\' event and run history', async () => {
    const { db } = mongoose.connection;
    await db.collection('system.profile').drop().catch(() => {});
    await db.command({ profile: 2 });
    try {
      const res = await request(app).get(`/api/registry/pods/${pod._id}/agents`).expect(200);
      expect(res.body.agents).toHaveLength(SEATS);
      expect(res.body.agents.every((a) => a.lastHeartbeatAt)).toBe(true);
    } finally {
      await db.command({ profile: 0 });
    }
    const ops = await db.collection('system.profile').find({
      ns: { $in: [`${db.databaseName}.agentevents`, `${db.databaseName}.agentruns`] },
    }).toArray();
    const examined = ops.reduce((sum, op) => sum + (op.keysExamined || 0) + (op.docsExamined || 0), 0);
    // Before: 333,325 delivered events fetched, twice, plus every run.
    expect(examined).toBeLessThanOrEqual(10 * SEATS);
  }, 60000);

  test(`a burst of ${BURST} rosters at once all answer well inside nginx's 5 s`, async () => {
    const times = await Promise.all(Array.from({ length: BURST }, async () => {
      const start = Date.now();
      await request(app).get(`/api/registry/pods/${pod._id}/agents`).expect(200);
      return Date.now() - start;
    }));
    expect(Math.max(...times)).toBeLessThan(BURST_BUDGET_MS);
  }, 120000);
});
