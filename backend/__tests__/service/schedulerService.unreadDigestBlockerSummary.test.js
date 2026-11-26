/**
 * F668: the unread-digest pass runs every minute inside the heartbeat tick.
 * On prod 2026-11-26 12:06 one tick took 4,913 ms (lease 536, schedules 541,
 * heartbeats 2,356), so about 1.5 s was this pass, and the event loop stalled
 * 2,035 ms. The tick enqueued nothing: every group that passed the install
 * checks was held by a pending or recent wake.
 *
 * Its wake checks (F635) shipped every pending and every recent non-digest
 * AgentEvent row for every due scope into Node, then filtered them by window
 * in JS: with windows up to a day, thousands of rows a minute to decide a few
 * dozen yes/no answers. Mongo now answers per scope (one summary row each),
 * and the recent read skips scopes a pending wake already holds.
 *
 * Real mongod, because the checks rely on Mongoose casting (agentName
 * lowercased on the query, podId cast) and on each group's own window.
 */
/* eslint-disable import/no-unresolved, import/extensions, no-await-in-loop */
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEvent = require('../../models/AgentEvent');
const AgentEventService = require('../../services/agentEventService');
const schedulerServiceInstance = require('../../services/schedulerService');

const SchedulerService = schedulerServiceInstance.constructor;

const NOW = new Date('2026-11-26T12:06:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const oid = () => new mongoose.Types.ObjectId();

const scopeKey = ({ agentName, instanceId, podId }) => (
  `${String(agentName).toLowerCase()}:${instanceId}:${String(podId)}`);
const enqueuedKeys = () => AgentEventService.enqueue.mock.calls.map(([arg]) => scopeKey(arg));

const installRow = (scope, config = null) => ({
  agentName: String(scope.agentName).toLowerCase(),
  instanceId: scope.instanceId ?? 'default',
  podId: scope.podId,
  status: 'active',
  version: '1.0.0',
  installedBy: oid(),
  ...(config ? { config } : {}),
});
const digestRow = (scope, at = minutesAgo(61)) => ({
  ...scope, type: 'message.posted', status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: at,
});
const wakeRow = (scope, fields) => ({
  agentName: String(scope.agentName).toLowerCase(),
  instanceId: scope.instanceId ?? 'default',
  podId: scope.podId,
  type: 'heartbeat',
  deliveryMode: 'wake',
  attempts: 1,
  createdAt: minutesAgo(200),
  ...fields,
});

// The candidate read groups pending digest; every other AgentEvent read in
// the pass is a wake check.
const isCandidateRead = (pipeline) => Boolean(pipeline?.[0]?.$match?.deliveryMode === 'digest');

/**
 * Counts the AgentEvent documents the wake checks hand to Node, whatever
 * shape the read takes (find or aggregate), and keeps each wake-check filter.
 */
const watchWakeCheckReads = () => {
  const seen = { rows: 0, filters: [] };
  const origQueryExec = mongoose.Query.prototype.exec;
  jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function exec(...args) {
    const result = await origQueryExec.apply(this, args);
    if (this.model?.modelName === 'AgentEvent' && this.op === 'find') {
      seen.rows += Array.isArray(result) ? result.length : 0;
      seen.filters.push(this.getFilter());
    }
    return result;
  });
  const origAggExec = mongoose.Aggregate.prototype.exec;
  jest.spyOn(mongoose.Aggregate.prototype, 'exec').mockImplementation(async function exec(...args) {
    const result = await origAggExec.apply(this, args);
    const pipeline = this.pipeline();
    if (this._model?.modelName === 'AgentEvent' && !isCandidateRead(pipeline)) {
      seen.rows += Array.isArray(result) ? result.length : 0;
      seen.filters.push(pipeline[0]?.$match);
    }
    return result;
  });
  return seen;
};

describe('F668 — the unread-digest wake checks are answered per scope by Mongo', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentInstallation.init();
    await AgentEvent.init();
  });

  beforeEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
    jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  it('2,000 candidates, none due: no wake, and the checks hand Node at most one row per scope', async () => {
    const SCOPES = 2000;
    const installs = [];
    const events = [];
    const pendingKeys = new Set();
    for (let i = 0; i < SCOPES; i += 1) {
      const scope = { agentName: `held${i}`, instanceId: 'default', podId: oid() };
      installs.push(installRow(scope, { heartbeat: { enabled: true }, digestWake: { afterMinutes: 1440 } }));
      events.push(digestRow(scope, minutesAgo(1500)));
      // Every scope had a busy day: five acked wakes inside its window.
      for (let j = 0; j < 5; j += 1) {
        events.push(wakeRow(scope, { status: 'acked', deliveredAt: minutesAgo(30 + j * 120) }));
      }
      // Half are also held by a wake still pending (an offline seat).
      if (i % 2 === 0) {
        events.push(wakeRow(scope, { type: 'chat.mention', status: 'pending', attempts: 0, createdAt: minutesAgo(3) }));
        pendingKeys.add(scopeKey(scope));
      }
    }
    await AgentInstallation.collection.insertMany(installs);
    await AgentEvent.collection.insertMany(events);
    const seen = watchWakeCheckReads();
    const existsSpy = jest.spyOn(AgentEvent, 'exists');
    const sink = {};

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW, sink)).toBe(0);

    expect(sink.due).toBe(SCOPES);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
    // The old checks handed Node 11,000 rows here (1,000 pending + 10,000 acked).
    expect(seen.rows).toBeLessThanOrEqual(SCOPES);
    // A scope a pending wake already holds is not read again for recent wakes.
    const recentScopes = seen.filters
      .filter((f) => f && f.status !== 'pending')
      .flatMap((f) => f.$or || [])
      .map(scopeKey);
    expect(recentScopes.length).toBe(SCOPES / 2);
    expect(recentScopes.some((key) => pendingKeys.has(key))).toBe(false);
  }, 60000);

  it('wakes exactly what the per-group exists checks woke, from summary rows', async () => {
    const s = (agentName, extra = {}) => ({ agentName, instanceId: 'default', podId: oid(), ...extra });
    const installs = [];
    const events = [];
    const groupScopes = [];
    const due = (scope, config = null, at = minutesAgo(61)) => {
      installs.push(installRow(scope, config));
      events.push(digestRow(scope, at));
      groupScopes.push({ scope, config });
      return scope;
    };
    // Free: no wake at all.
    const free = due(s('free'));
    // Pending wake, plus a pile of old acks.
    const pend = due(s('pend'));
    events.push(wakeRow(pend, { status: 'pending', attempts: 0, createdAt: minutesAgo(4) }));
    // Many acks, the newest inside the hour.
    const busy = due(s('busy'));
    [5, 10, 20, 30, 40, 50, 70, 130].forEach((m) => events.push(wakeRow(busy,
      { status: 'acked', deliveredAt: minutesAgo(m) })));
    // Many acks, all outside the hour: wakes.
    const stale = due(s('stale'));
    [70, 130, 190].forEach((m) => events.push(wakeRow(stale, { status: 'acked', deliveredAt: minutesAgo(m) })));
    // A day-long wait: a delivery 10 hours ago still holds it.
    const dayWait = due(s('daywait'), { digestWake: { afterMinutes: 1440 } }, minutesAgo(1500));
    [600, 700, 800, 900, 1000].forEach((m) => events.push(wakeRow(dayWait,
      { status: 'delivered', deliveredAt: minutesAgo(m) })));
    // A two-hour wait, delivered 3 hours ago: wakes.
    const twoHour = due(s('twohour'), { digestWake: { afterMinutes: 120 } }, minutesAgo(200));
    events.push(wakeRow(twoHour, { status: 'delivered', deliveredAt: minutesAgo(180) }));
    // Failed inside the window by updatedAt, delivered long before.
    const failedIn = due(s('failedin'));
    events.push(wakeRow(failedIn, { status: 'failed', deliveredAt: minutesAgo(300), updatedAt: minutesAgo(15) }));
    // Failed outside the window though delivered recently, beside an old ack.
    const failedOut = due(s('failedout'));
    events.push(wakeRow(failedOut, { status: 'failed', deliveredAt: minutesAgo(20), updatedAt: minutesAgo(65) }));
    events.push(wakeRow(failedOut, { status: 'acked', deliveredAt: minutesAgo(90) }));
    // Delivered digest inside the window is not a wake.
    const digestOnly = due(s('digestonly'));
    events.push(wakeRow(digestOnly, { status: 'delivered', deliveryMode: 'digest', deliveredAt: minutesAgo(5) }));
    // A mixed-case group whose scope has recent acks stored lowercase.
    const mixedPod = oid();
    installs.push(installRow({ agentName: 'mixedcase', podId: mixedPod }));
    events.push(digestRow({ agentName: 'MixedCase', instanceId: 'default', podId: mixedPod }));
    [5, 25].forEach((m) => events.push(wakeRow({ agentName: 'mixedcase', podId: mixedPod },
      { status: 'acked', deliveredAt: minutesAgo(m) })));
    await AgentInstallation.collection.insertMany(installs);
    await AgentEvent.collection.insertMany(events);

    // The oracle: the per-group pair of `exists` the pass made before F635,
    // each group with its own window, run before the pass writes anything.
    const expected = [];
    for (const { scope, config } of groupScopes) {
      const waitMs = SchedulerService.resolveDigestWakeAfterMinutes({ config }) * 60000;
      const windowStart = new Date(NOW.getTime() - waitMs);
      const [pendingWake, recentWake] = await Promise.all([
        AgentEvent.exists({ ...scope, status: 'pending', deliveryMode: { $ne: 'digest' } }),
        AgentEvent.exists({ ...scope, deliveryMode: { $ne: 'digest' }, $or: [
          { status: { $in: ['delivered', 'acked'] }, deliveredAt: { $gte: windowStart } },
          { status: 'failed', updatedAt: { $gte: windowStart } },
        ] }),
      ]);
      if (!pendingWake && !recentWake) expected.push(scopeKey(scope));
    }
    expect(expected.sort()).toEqual([free, stale, twoHour, failedOut, digestOnly].map(scopeKey).sort());

    const seen = watchWakeCheckReads();
    const count = await SchedulerService.dispatchUnreadDigestHeartbeats(NOW);

    expect(enqueuedKeys().sort()).toEqual(expected);
    expect(count).toBe(expected.length);
    // Eleven due groups: one summary row per scope at most, not every ack.
    expect(seen.rows).toBeLessThanOrEqual(11);
  });
});
