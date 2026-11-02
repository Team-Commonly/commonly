// F65 (11-02): GET /pods/:podId/agents ran its ~21 queries one after another.
// At prod's ~42ms a round trip that is 0.85s for a one-agent pod and up to
// 1.7s for a 23-agent pod before any load, and the pages that fetch it once
// per pod (Your Team, Activity, Connectors) sent ~100 at once and drew 504s
// at nginx's 5s limit (08:58Z). Queries that need only the pod's installs run
// together, so the request costs a handful of round trips, not one per query.
// The measure is round trips. Every Mongo and PG query is held until the
// test releases a round: it waits until nothing more is issued, then releases
// every held query at once. Rounds count the request's critical path, with no
// clock in it, so a slow runner cannot add one. The reads also share at most POD_AGENTS_READ_CONCURRENCY connections: at
// prod's pool of 100, ~100 uncapped requests at ~12 reads each queued chat and
// auth queries behind ~1,100 others (modelled chat p95 128ms → 512ms).
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const mockViewer = '6a0000000000000000000001';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = mockViewer;
  req.user = { id: mockViewer };
  next();
});
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn().mockResolvedValue(true) }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const PgMessage = require('../../../models/pg/Message');
const podAgentsRouter = require('../../../routes/registry/pod-agents');
const { POD_AGENTS_READ_CONCURRENCY } = require('../../../routes/registry/pod-agents');

const app = express();
app.use(express.json());
app.use('/api/registry', podAgentsRouter);

const viewer = new mongoose.Types.ObjectId(mockViewer);
const pod = new mongoose.Types.ObjectId();

// Hold every query until the next round. `running` counts released queries
// still doing their real I/O against the in-memory server.
const meter = {
  on: false, rounds: 0, queries: 0, pgQueries: 0, peak: 0, held: [], running: 0,
};
const held = (run) => new Promise((resolve, reject) => {
  meter.queries += 1;
  meter.held.push(() => {
    meter.running += 1;
    Promise.resolve().then(run).then(resolve, reject).finally(() => { meter.running -= 1; });
  });
});
// Quiet: no released query is still running, and three event-loop turns pass
// with no new query held. Follow-on queries are issued in microtasks of the
// turn their predecessor finished in, so one quiet turn would already do.
const quiet = async () => {
  let still = 0;
  let last = -1;
  while (still < 3) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setImmediate(resolve); });
    if (meter.running === 0 && meter.held.length === last) still += 1;
    else { still = 0; last = meter.held.length; }
  }
};
const measure = async (path) => {
  Object.assign(meter, {
    on: true, rounds: 0, queries: 0, pgQueries: 0, peak: 0, held: [], running: 0,
  });
  let done = false;
  const response = request(app).get(path).then((res) => { done = true; return res; });
  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    await quiet();
    if (meter.held.length > 0) {
      meter.rounds += 1;
      meter.peak = Math.max(meter.peak, meter.held.length);
      meter.held.splice(0).forEach((release) => release());
    }
  }
  meter.on = false;
  return response;
};
const hold = (proto) => {
  const { exec } = proto;
  // eslint-disable-next-line no-param-reassign
  proto.exec = function heldExec(...args) {
    if (!meter.on) return exec.apply(this, args);
    return held(() => exec.apply(this, args));
  };
  return exec;
};
// The route's two PG reads answer from no database here, so they are held and
// counted like Mongo: a PG read that waits on other reads adds rounds.
const holdPg = (name, answer) => jest.spyOn(PgMessage, name).mockImplementation(() => {
  if (!meter.on) return Promise.resolve(answer);
  meter.pgQueries += 1;
  return held(async () => answer);
});
let restoreQuery;
let restoreAggregate;

beforeAll(async () => {
  await setupMongoDb();
  restoreQuery = hold(mongoose.Query.prototype);
  restoreAggregate = hold(mongoose.Aggregate.prototype);
});
beforeEach(() => {
  holdPg('findLastMessagePerUserInPod', []);
  holdPg('hasMessageByUserInPod', false);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  mongoose.Query.prototype.exec = restoreQuery;
  mongoose.Aggregate.prototype.exec = restoreAggregate;
  await closeMongoDb();
});
beforeEach(async () => {
  await Pod.collection.insertOne({
    _id: pod, name: 'p', type: 'chat', createdBy: viewer, members: [viewer],
  });
  const names = ['scout', 'sprint-review', 'linear-walk'];
  await Promise.all(names.map((name) => AgentInstallation.create({
    agentName: name, instanceId: 'default', podId: pod, version: '1.0.0', installedBy: viewer, status: 'active', config: {},
  })));
  await User.collection.insertMany(names.map((name) => ({
    username: name, email: `${name}@agents.test`, isBot: true, botMetadata: { agentName: name, instanceId: 'default' },
  })));
});
afterEach(clearMongoDb);

describe('GET /pods/:podId/agents round trips', () => {
  it('answers the full roster', async () => {
    const res = await request(app).get(`/api/registry/pods/${pod}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents.map((a) => a.name || a.agentName).sort()).toEqual(['linear-walk', 'scout', 'sprint-review']);
  });

  it('costs a few round trips, not one per query', async () => {
    const res = await measure(`/api/registry/pods/${pod}/agents`);
    expect(res.status).toBe(200);
    expect(meter.pgQueries).toBe(2);
    expect(meter.queries).toBeGreaterThan(10);
    // Measured: main 20 rounds for 21 queries; this change 7, and 6 uncapped.
    // A PG read made to wait on the Mongo reads measures 8. Rounds have no
    // clock in them, so the bound is the measured count.
    expect(meter.rounds).toBeLessThanOrEqual(7);
  });

  it('keeps at most POD_AGENTS_READ_CONCURRENCY reads in flight', async () => {
    expect(POD_AGENTS_READ_CONCURRENCY).toBe(4);
    const res = await measure(`/api/registry/pods/${pod}/agents`);
    expect(res.status).toBe(200);
    expect(meter.peak).toBeGreaterThan(1);
    expect(meter.peak).toBeLessThanOrEqual(POD_AGENTS_READ_CONCURRENCY);
  });

  it('fails on a failed User read without blaming the reads that wait on it', async () => {
    const { find } = User;
    const findSpy = jest.spyOn(User, 'find').mockImplementation(function findBotRows(filter, ...rest) {
      if (filter && filter.username) {
        return { select: () => ({ lean: () => Promise.reject(new Error('user read down')) }) };
      }
      return find.call(this, filter, ...rest);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app).get(`/api/registry/pods/${pod}/agents`);
      expect(res.status).toBe(500);
      const warned = warn.mock.calls.map((call) => String(call[0]));
      expect(warned.filter((line) => /connection lookup|last-message lookup/.test(line))).toEqual([]);
    } finally {
      findSpy.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
