/**
 * F635: the unread-digest wake pass checks pending and recent wakes in one
 * batch, not two `exists` per due group.
 *
 * Measured on prod 2026-11-25: 82 due groups, each pair of index-hit `exists`
 * calls one ~15 ms round trip, run one group after another: 1,327 ms of the
 * minute cron spent waiting on the network.
 *
 * Real mongod, because the old per-group `exists` relied on Mongoose casting
 * (agentName lowercased on the query, podId cast to an ObjectId) and on each
 * group's own wait window; the batch has to make exactly the same calls.
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

const NOW = new Date('2026-11-25T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const oid = () => new mongoose.Types.ObjectId();

const install = (scope, config = null) => AgentInstallation.collection.insertOne({
  agentName: String(scope.agentName).toLowerCase(),
  instanceId: scope.instanceId ?? 'default',
  podId: scope.podId,
  status: 'active',
  version: '1.0.0',
  installedBy: oid(),
  ...(config ? { config } : {}),
});
const digestEvent = (scope, at = minutesAgo(61)) => AgentEvent.collection.insertOne({
  ...scope, type: 'message.posted', status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: at,
});
const wakeEvent = (scope, fields) => AgentEvent.collection.insertOne({
  agentName: String(scope.agentName).toLowerCase(),
  instanceId: scope.instanceId ?? 'default',
  podId: scope.podId,
  type: 'heartbeat',
  deliveryMode: 'wake',
  attempts: 1,
  createdAt: minutesAgo(200),
  ...fields,
});

// What the real enqueue leaves behind for the next check to find: a pending
// wake (an external seat) on the scope. The real one can also write it
// `delivered` with deliveredAt now (a native seat); both count as a wake.
const writingEnqueue = async ({ agentName, instanceId, podId, type, payload }) => AgentEvent.create({
  agentName: agentName.toLowerCase(), instanceId, podId, type, payload,
});

const scopeKey = ({ agentName, instanceId, podId }) => (
  `${String(agentName).toLowerCase()}:${instanceId}:${String(podId)}`);
const enqueuedKeys = () => AgentEventService.enqueue.mock.calls.map(([arg]) => scopeKey(arg));

/** One group per decision the wake checks make. Returns the scopes that must wake. */
const seedChecks = async () => {
  const expected = [];
  const s = (agentName, extra = {}) => ({ agentName, instanceId: 'default', podId: oid(), ...extra });
  const due = async (scope, config, at) => {
    await install(scope, config);
    await digestEvent(scope, at);
    return scope;
  };

  // Only digest is pending: a digest-only queue is not a pending wake.
  expected.push(await due(s('digestonly')));
  // A pending wake will carry the digest.
  const pendingWake = await due(s('pendingwake'));
  await wakeEvent(pendingWake, { status: 'pending', attempts: 0, createdAt: minutesAgo(5) });
  // Two groups with different waits (60 and 120 min), each with a wake
  // delivered 90 min ago. The batch reads from the earliest window (120 min);
  // each group must still apply its own: outside 60 min wakes, inside 120 skips.
  const short = await due(s('shortwait'), { digestWake: { afterMinutes: 60 } }, minutesAgo(150));
  await wakeEvent(short, { status: 'delivered', deliveredAt: minutesAgo(90), updatedAt: minutesAgo(1) });
  expected.push(short);
  const long = await due(s('longwait'), { digestWake: { afterMinutes: 120 } }, minutesAgo(150));
  await wakeEvent(long, { status: 'delivered', deliveredAt: minutesAgo(90), updatedAt: minutesAgo(90) });
  // Delivered inside the default window.
  const deliveredIn = await due(s('deliveredin'));
  await wakeEvent(deliveredIn, { status: 'delivered', deliveredAt: minutesAgo(20) });
  // Acked inside the window.
  const acked = await due(s('ackedin'));
  await wakeEvent(acked, { status: 'acked', deliveredAt: minutesAgo(30) });
  // Acked outside the window.
  expected.push(await due(s('ackedout')));
  await wakeEvent(expected[expected.length - 1], { status: 'acked', deliveredAt: minutesAgo(70) });
  // Failed inside the window, by updatedAt (it was delivered long ago).
  const failedIn = await due(s('failedin'));
  await wakeEvent(failedIn, { status: 'failed', deliveredAt: minutesAgo(180), updatedAt: minutesAgo(10) });
  // Failed outside the window, even though it was delivered recently.
  const failedOut = await due(s('failedout'));
  await wakeEvent(failedOut, { status: 'failed', deliveredAt: minutesAgo(20), updatedAt: minutesAgo(65) });
  expected.push(failedOut);
  // A digest event delivered inside the window is not a wake.
  const digestDelivered = await due(s('digestdelivered'));
  await wakeEvent(digestDelivered, { status: 'delivered', deliveryMode: 'digest', deliveredAt: minutesAgo(5) });
  expected.push(digestDelivered);
  // A wake on another pod of the same identity does not count.
  const otherPod = await due(s('otherpod'));
  await wakeEvent({ ...otherPod, podId: oid() }, { status: 'pending', attempts: 0 });
  expected.push(otherPod);
  // A wake on another instance of the same identity and pod does not count.
  const otherInst = await due(s('otherinst'));
  await wakeEvent({ ...otherInst, instanceId: 'b' }, { status: 'pending', attempts: 0 });
  expected.push(otherInst);
  // Two groups on one scope (one digest event with no instanceId, one with
  // 'default'): the first wakes, and the second finds that wake.
  const pair = s('pairseat');
  await install(pair);
  await AgentEvent.collection.insertOne({ agentName: 'pairseat', podId: pair.podId, type: 'message.posted',
    status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: minutesAgo(61) });
  await digestEvent(pair);
  expected.push(pair);
  // Two groups on one scope by agentName case.
  const casePod = oid();
  await install({ agentName: 'casepair', podId: casePod });
  await digestEvent({ agentName: 'CasePair', instanceId: 'default', podId: casePod });
  await digestEvent({ agentName: 'casepair', instanceId: 'default', podId: casePod });
  expected.push({ agentName: 'casepair', instanceId: 'default', podId: casePod });
  // A mixed-case group whose scope has a pending wake (stored lowercase).
  const mixedPod = oid();
  await install({ agentName: 'mixedwake', podId: mixedPod });
  await digestEvent({ agentName: 'MixedWake', instanceId: 'default', podId: mixedPod });
  await wakeEvent({ agentName: 'mixedwake', podId: mixedPod }, { status: 'pending', attempts: 0 });

  return expected;
};

const isBatchWakeRead = (filter) => Boolean(filter && (filter.$or || filter.$and)
  && JSON.stringify(filter).includes('"deliveryMode":{"$ne":"digest"}'));

describe('F635 — the unread-digest wake checks run in one batch', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentInstallation.init();
    await AgentEvent.init();
  });

  beforeEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
    jest.spyOn(AgentEventService, 'enqueue').mockImplementation(writingEnqueue);
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  describe.each([
    ['batched checks', false],
    ['per-group fallback after a batched read fails', true],
  ])('wakes exactly the scopes the per-group checks woke (%s)', (_label, failBatch) => {
    it('skips pending and recent wakes, each by its own window, and wakes a scope once', async () => {
      const expected = await seedChecks();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      if (failBatch) {
        const originalFind = AgentEvent.find;
        jest.spyOn(AgentEvent, 'find').mockImplementation(function find(filter, ...rest) {
          if (isBatchWakeRead(filter)) throw new Error('wake batch down');
          return originalFind.call(this, filter, ...rest);
        });
      }

      const count = await SchedulerService.dispatchUnreadDigestHeartbeats(NOW);

      expect(enqueuedKeys().sort()).toEqual(expected.map(scopeKey).sort());
      expect(count).toBe(expected.length);
      const logged = errorSpy.mock.calls.filter((c) => String(c[1]).includes('digest wake check batch'));
      expect(logged).toHaveLength(failBatch ? 1 : 0);
    });
  });

  it('checks 82 due groups in a small constant number of AgentEvent queries, not 164', async () => {
    const events = [];
    const installs = [];
    for (let i = 0; i < 82; i += 1) {
      const scope = { agentName: `seat${i}`, instanceId: 'default', podId: oid() };
      events.push({ ...scope, type: 'message.posted', status: 'pending', deliveryMode: 'digest',
        attempts: 0, createdAt: minutesAgo(61) });
      installs.push({ ...scope, status: 'active', version: '1.0.0', installedBy: oid() });
      // Every fourth has a recent wake, every fifth a pending one.
      if (i % 4 === 0) {
        events.push({ ...scope, type: 'heartbeat', status: 'acked', deliveryMode: 'wake', attempts: 1,
          createdAt: minutesAgo(20), deliveredAt: minutesAgo(15) });
      } else if (i % 5 === 0) {
        events.push({ ...scope, type: 'chat.mention', status: 'pending', deliveryMode: 'wake', attempts: 0,
          createdAt: minutesAgo(2) });
      }
    }
    await AgentEvent.collection.insertMany(events);
    await AgentInstallation.collection.insertMany(installs);
    const expected = [...Array(82).keys()].filter((i) => i % 4 !== 0 && i % 5 !== 0).length;
    jest.spyOn(AgentEventService, 'enqueue').mockResolvedValue({});
    const existsSpy = jest.spyOn(AgentEvent, 'exists');
    const findSpy = jest.spyOn(AgentEvent, 'find');

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(expected);

    expect(existsSpy).not.toHaveBeenCalled();
    expect(findSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('a failed batch read falls back to the per-group checks, still wakes, and logs once', async () => {
    const scopes = [];
    for (let i = 0; i < 3; i += 1) {
      const scope = { agentName: `fb${i}`, instanceId: 'default', podId: oid() };
      await install(scope);
      await digestEvent(scope);
      scopes.push(scope);
    }
    await wakeEvent(scopes[1], { status: 'pending', attempts: 0 });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const originalFind = AgentEvent.find;
    jest.spyOn(AgentEvent, 'find').mockImplementation(function find(filter, ...rest) {
      if (isBatchWakeRead(filter)) {
        const q = { select: () => q, lean: () => Promise.reject(new Error('wake batch down')) };
        return q;
      }
      return originalFind.call(this, filter, ...rest);
    });
    const existsSpy = jest.spyOn(AgentEvent, 'exists');

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(2);
    expect(enqueuedKeys().sort()).toEqual([scopes[0], scopes[2]].map(scopeKey).sort());
    expect(existsSpy).toHaveBeenCalledTimes(6);
    const logged = errorSpy.mock.calls.filter((c) => String(c[1]).includes('digest wake check batch'));
    expect(logged).toHaveLength(1);
  });

  it('reads recent wakes with one top-level $or, each scope bounded by its own window', async () => {
    const long = { agentName: 'longday', instanceId: 'default', podId: oid() };
    const short = { agentName: 'shorthour', instanceId: 'default', podId: oid() };
    await install(long, { digestWake: { afterMinutes: 1440 } });
    await digestEvent(long, minutesAgo(1500));
    await install(short, { digestWake: { afterMinutes: 60 } });
    await digestEvent(short, minutesAgo(61));
    // Delivered 2 hours ago: inside the long scope's day, outside the short
    // scope's hour, so it must not make the short group skip.
    await wakeEvent(short, { status: 'delivered', deliveredAt: minutesAgo(120) });
    const findSpy = jest.spyOn(AgentEvent, 'find');

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(2);
    expect(enqueuedKeys().sort()).toEqual([long, short].map(scopeKey).sort());

    const recentFilters = findSpy.mock.calls.map(([f]) => f).filter((f) => f && f.status !== 'pending');
    expect(recentFilters).toHaveLength(1);
    const [filter] = recentFilters;
    expect(filter.$and).toBeUndefined();
    expect(Object.keys(filter)).toEqual(['$or']);
    const windowOf = (scope) => {
      const clause = filter.$or.find((c) => c.agentName === scope.agentName);
      expect(clause).toEqual({
        agentName: scope.agentName,
        instanceId: scope.instanceId,
        podId: scope.podId,
        deliveryMode: { $ne: 'digest' },
        $or: [
          { status: { $in: ['delivered', 'acked'] }, deliveredAt: { $gte: expect.any(Date) } },
          { status: 'failed', updatedAt: { $gte: expect.any(Date) } },
        ],
      });
      expect(clause.$or[1].updatedAt.$gte).toEqual(clause.$or[0].deliveredAt.$gte);
      return clause.$or[0].deliveredAt.$gte;
    };
    expect(windowOf(long)).toEqual(minutesAgo(1440));
    expect(windowOf(short)).toEqual(minutesAgo(60));
  });

  it('two groups on one scope share one clause, and both apply its window', async () => {
    // Two groups on one scope: an event with no instanceId and one with
    // 'default'. They resolve to the same install, so the same wait; a
    // 120-minute wait and a delivery 90 minutes ago, inside it: both skip.
    const scope = { agentName: 'sharedwin', instanceId: 'default', podId: oid() };
    await install(scope, { digestWake: { afterMinutes: 120 } });
    await AgentEvent.collection.insertOne({ agentName: 'sharedwin', podId: scope.podId, type: 'message.posted',
      status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: minutesAgo(150) });
    await digestEvent(scope, minutesAgo(150));
    await wakeEvent(scope, { status: 'delivered', deliveredAt: minutesAgo(90) });
    const findSpy = jest.spyOn(AgentEvent, 'find');

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(0);
    const recent = findSpy.mock.calls.map(([f]) => f).find((f) => f && f.status !== 'pending');
    expect(recent.$or).toHaveLength(1);
  });

  it('a scope woken by a native enqueue (delivered now) is not woken again by a second group', async () => {
    const nativeEnqueue = async ({
      agentName, instanceId, podId, type, payload,
    }) => (
      AgentEvent.create({
        agentName: agentName.toLowerCase(), instanceId, podId, type, payload,
        status: 'delivered', deliveredAt: new Date(), attempts: 1,
      }));
    jest.spyOn(AgentEventService, 'enqueue').mockImplementation(nativeEnqueue);
    const scope = { agentName: 'nativepair', instanceId: 'default', podId: oid() };
    await install(scope);
    await AgentEvent.collection.insertOne({ agentName: 'nativepair', podId: scope.podId, type: 'message.posted',
      status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: minutesAgo(61) });
    await digestEvent(scope);

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('treats a row with no deliveryMode field as a wake', async () => {
    const pend = { agentName: 'nomodepend', instanceId: 'default', podId: oid() };
    const recent = { agentName: 'nomoderecent', instanceId: 'default', podId: oid() };
    const free = { agentName: 'nomodefree', instanceId: 'default', podId: oid() };
    await Promise.all([pend, recent, free].map(async (s) => {
      await install(s);
      await digestEvent(s);
    }));
    await AgentEvent.collection.insertOne({ ...pend, type: 'chat.mention', status: 'pending', attempts: 0,
      createdAt: minutesAgo(3) });
    await AgentEvent.collection.insertOne({ ...recent, type: 'heartbeat', status: 'acked', attempts: 1,
      createdAt: minutesAgo(30), deliveredAt: minutesAgo(20) });

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    expect(enqueuedKeys()).toEqual([scopeKey(free)]);
  });

  it('fills the sub-step timings and the due count when given a sink', async () => {
    const a = { agentName: 'tima', instanceId: 'default', podId: oid() };
    const b = { agentName: 'timb', instanceId: 'default', podId: oid() };
    await install(a);
    await digestEvent(a);
    await install(b);
    await digestEvent(b);
    await wakeEvent(b, { status: 'pending', attempts: 0 });
    const sink = {};

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW, sink)).toBe(1);

    const keys = ['unreadEvents', 'unreadFold', 'unreadInstalls', 'unreadAllowed', 'unreadChecks', 'unreadEnqueue'];
    expect(Object.keys(sink).sort()).toEqual([...keys, 'due'].sort());
    keys.forEach((key) => {
      expect(typeof sink[key]).toBe('number');
      expect(sink[key]).toBeGreaterThanOrEqual(0);
    });
    expect(sink.due).toBe(2);
  });
});
