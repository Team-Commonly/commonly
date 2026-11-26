/**
 * F634: the unread-digest wake pass reads installs in one batch, not one
 * query per group.
 *
 * Measured on prod 2026-11-25: 444 due digest groups, 362 of them (82%) with
 * no active install, one projected findOne at 16.3 ms, so the pass spent about
 * 14.4 s of a 15 s heartbeat run waiting on Mongo round trips just to skip
 * retired projections.
 *
 * Real mongod, because the old per-group findOne relied on Mongoose casting
 * (agentName lowercased, a string podId cast to an ObjectId) and the batch has
 * to make exactly the same matches. A mock would agree with any query.
 */
/* eslint-disable import/no-unresolved, import/extensions */
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEvent = require('../../models/AgentEvent');
const AgentDigestState = require('../../models/AgentDigestState');
const AgentEventService = require('../../services/agentEventService');
const schedulerServiceInstance = require('../../services/schedulerService');

const SchedulerService = schedulerServiceInstance.constructor;

const NOW = new Date('2026-11-25T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const CONTENT = '[Unread pod activity is waiting. Read the digest in this inbox batch; respond only if useful.]';

const isBatchInstallRead = (filter) => Boolean(filter && filter.$or && 'config.autonomy.enabled' in filter);
const isBatchSiblingRead = (filter) => Boolean(filter && filter.$or && 'config.runtime.runtimeType' in filter);
const rejectingQuery = (message) => {
  const query = {
    select: () => query,
    sort: () => query,
    lean: () => Promise.reject(new Error(message)),
  };
  return query;
};

const oid = () => new mongoose.Types.ObjectId();
const install = (scope, config, extra = {}) => AgentInstallation.collection.insertOne({
  agentName: scope.agentName,
  instanceId: scope.instanceId ?? 'default',
  podId: scope.podId,
  status: 'active',
  version: '1.0.0',
  installedBy: oid(),
  ...(config ? { config } : {}),
  ...extra,
});
const digestEvent = (scope, at = minutesAgo(61)) => AgentEvent.collection.insertOne({
  ...scope, type: 'message.posted', status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: at,
});

/**
 * Every decision the pass makes, one scope each. Returns the scopes that must
 * get a wake, as the enqueue sees them.
 */
const seedMatrix = async () => {
  const expected = [];
  const s = (agentName, extra = {}) => ({ agentName, instanceId: 'default', podId: oid(), ...extra });

  // No active install: a retired projection.
  await digestEvent(s('noinstall'));
  // An install that exists but is not active.
  const removed = s('removed');
  await install(removed, null, { status: 'uninstalled' });
  await digestEvent(removed);
  // Autonomy switched off.
  const autoOff = s('autooff');
  await install(autoOff, { autonomy: { enabled: false } });
  await digestEvent(autoOff);
  // Hosted, but the owner turned the heartbeat on.
  const hbOn = s('hbon');
  await install(hbOn, { runtime: { runtimeType: 'hosted' }, heartbeat: { enabled: true, everyMinutes: 60 } });
  await digestEvent(hbOn);
  expected.push(hbOn);
  // Own runtime, hosted, heartbeat off.
  const ownHosted = s('ownhosted');
  await install(ownHosted, { runtime: { runtimeType: 'hosted' }, heartbeat: null });
  await digestEvent(ownHosted);
  // Own runtime, not hosted.
  const ownNative = s('ownnative');
  await install(ownNative, { runtime: { runtimeType: 'native' } });
  await digestEvent(ownNative);
  expected.push(ownNative);
  // No runtime of its own; the identity's newest configured row is hosted.
  const sibHosted = s('sibhosted');
  await install({ ...sibHosted, podId: oid() }, { runtime: { runtimeType: 'hosted' } }, { createdAt: minutesAgo(500) });
  await install(sibHosted, { heartbeat: null });
  await digestEvent(sibHosted);
  // No runtime of its own; the newest configured row is not hosted (an older
  // hosted one must lose to it).
  const sibNative = s('sibnative');
  await install({ ...sibNative, podId: oid() }, { runtime: { runtimeType: 'hosted' } }, { createdAt: minutesAgo(900) });
  await install({ ...sibNative, podId: oid() }, { runtime: { runtimeType: 'webhook' } },
    { createdAt: minutesAgo(300) });
  await install(sibNative, null);
  await digestEvent(sibNative);
  expected.push(sibNative);
  // No runtime anywhere for the identity: not hosted, so it wakes.
  const noRuntime = s('noruntime');
  await install(noRuntime, null);
  await digestEvent(noRuntime);
  expected.push(noRuntime);
  // The install's longer wait is not reached yet.
  const waiting = s('waiting');
  await install(waiting, { digestWake: { afterMinutes: 240 } });
  await digestEvent(waiting);
  // A pending wake will carry the digest.
  const pending = s('pendingwake');
  await install(pending, null);
  await digestEvent(pending);
  await AgentEvent.collection.insertOne({ ...pending, type: 'chat.mention', status: 'pending',
    deliveryMode: 'wake', attempts: 0, createdAt: minutesAgo(5) });
  // A wake delivered inside the window.
  const delivered = s('delivered');
  await install(delivered, null);
  await digestEvent(delivered);
  await AgentEvent.collection.insertOne({ ...delivered, type: 'heartbeat', status: 'delivered',
    deliveryMode: 'wake', attempts: 1, createdAt: minutesAgo(30), deliveredAt: minutesAgo(20) });
  // A wake that failed inside the window.
  const failed = s('failedwake');
  await install(failed, null);
  await digestEvent(failed);
  await AgentEvent.collection.insertOne({ ...failed, type: 'heartbeat', status: 'failed',
    deliveryMode: 'wake', attempts: 1, createdAt: minutesAgo(90), updatedAt: minutesAgo(10) });
  // Plainly eligible.
  const eligible = s('eligible');
  await install(eligible, null);
  await digestEvent(eligible);
  expected.push(eligible);
  // Folded past retention: only AgentDigestState holds the unread.
  const folded = s('folded');
  await install(folded, null);
  await AgentDigestState.collection.insertOne({ ...folded, unreadCount: 3, revision: 3,
    lastEventIds: ['a'], unreadSince: minutesAgo(75), updatedAt: NOW });
  expected.push(folded);
  // A digest event whose podId was stored as a string. The old findOne cast it
  // to the install's ObjectId; the batch must match it the same way.
  const strPodId = oid();
  await install({ agentName: 'strpod', podId: strPodId }, null);
  const strScope = { agentName: 'strpod', instanceId: 'default', podId: String(strPodId) };
  await digestEvent(strScope);
  expected.push(strScope);
  // The event's agentName is mixed case; the schema lowercases agentName on
  // the query, so the old findOne matched the lowercase install.
  const mixedPod = oid();
  await install({ agentName: 'mixedcase', podId: mixedPod }, null);
  const mixed = { agentName: 'MixedCase', instanceId: 'default', podId: mixedPod };
  await digestEvent(mixed);
  expected.push(mixed);
  // An event with no instanceId defaults to 'default'.
  const noInstPod = oid();
  await install({ agentName: 'noinst', podId: noInstPod }, null);
  await AgentEvent.collection.insertOne({ agentName: 'noinst', podId: noInstPod, type: 'message.posted',
    status: 'pending', deliveryMode: 'digest', attempts: 0, createdAt: minutesAgo(61) });
  expected.push({ agentName: 'noinst', instanceId: 'default', podId: noInstPod });
  // A non-default instance does not borrow the default instance's install.
  const otherInst = s('otherinst', { instanceId: 'b' });
  await install({ ...otherInst, instanceId: 'default' }, null);
  await digestEvent(otherInst);

  return expected;
};

const scopeKey = ({ agentName, instanceId, podId }) => `${agentName}:${instanceId}:${String(podId)}`;

describe('F634 — the unread-digest wake pass batches its install reads', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentInstallation.init();
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

  describe.each([
    ['batched read', false],
    ['per-group fallback after the batched read fails', true],
  ])('decisions are unchanged (%s)', (_label, failBatch) => {
    it('wakes exactly the eligible scopes, with the same payload', async () => {
      const expected = await seedMatrix();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      if (failBatch) {
        const originalFind = AgentInstallation.find;
        jest.spyOn(AgentInstallation, 'find').mockImplementation(function find(filter, ...rest) {
          if (isBatchInstallRead(filter)) return rejectingQuery('batch read down');
          return originalFind.call(this, filter, ...rest);
        });
      }

      const count = await SchedulerService.dispatchUnreadDigestHeartbeats(NOW);

      const calls = AgentEventService.enqueue.mock.calls.map(([arg]) => arg);
      expect(calls.map(scopeKey).sort()).toEqual(expected.map(scopeKey).sort());
      expect(count).toBe(expected.length);
      calls.forEach((arg) => {
        const want = expected.find((scope) => scopeKey(scope) === scopeKey(arg));
        expect(arg).toEqual({
          agentName: want.agentName,
          instanceId: want.instanceId,
          podId: want.podId,
          type: 'heartbeat',
          payload: {
            trigger: 'unread-digest',
            podId: String(want.podId),
            generatedAt: NOW.toISOString(),
            content: CONTENT,
          },
        });
      });
      if (failBatch) {
        // Logged once for the pass, not once per group.
        const logged = errorSpy.mock.calls.filter((c) => String(c[1]).includes('digest wake install batch'));
        expect(logged).toHaveLength(1);
      }
    });
  });

  it('reads installs in a constant number of queries: 300 groups, 290 with no install', async () => {
    const events = [];
    const installs = [];
    for (let i = 0; i < 300; i += 1) {
      const scope = { agentName: `seat${i}`, instanceId: 'default', podId: oid() };
      events.push({ ...scope, type: 'message.posted', status: 'pending', deliveryMode: 'digest',
        attempts: 0, createdAt: minutesAgo(61) });
      if (i < 10) {
        installs.push({ ...scope, status: 'active', version: '1.0.0', installedBy: oid() });
      }
    }
    await AgentEvent.collection.insertMany(events);
    await AgentInstallation.collection.insertMany(installs);
    const findSpy = jest.spyOn(AgentInstallation, 'find');
    const findOneSpy = jest.spyOn(AgentInstallation, 'findOne');

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(10);

    const installQueries = findSpy.mock.calls.length + findOneSpy.mock.calls.length;
    expect(findOneSpy).not.toHaveBeenCalled();
    expect(installQueries).toBeLessThanOrEqual(4);
  });

  it('holds the groups whose sibling batch fails, logs once, and still wakes the rest', async () => {
    const own = { agentName: 'ownrt', instanceId: 'default', podId: oid() };
    await install(own, { runtime: { runtimeType: 'native' } });
    await digestEvent(own);
    const needsSibling = [];
    for (let i = 0; i < 3; i += 1) {
      const scope = { agentName: `nort${i}`, instanceId: 'default', podId: oid() };
      // eslint-disable-next-line no-await-in-loop
      await install(scope, null);
      // eslint-disable-next-line no-await-in-loop
      await digestEvent(scope);
      needsSibling.push(scope);
    }
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const originalFind = AgentInstallation.find;
    jest.spyOn(AgentInstallation, 'find').mockImplementation(function find(filter, ...rest) {
      if (isBatchSiblingRead(filter)) return rejectingQuery('sibling read down');
      return originalFind.call(this, filter, ...rest);
    });

    expect(await SchedulerService.dispatchUnreadDigestHeartbeats(NOW)).toBe(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue.mock.calls[0][0]).toEqual(expect.objectContaining(own));
    const logged = warnSpy.mock.calls.filter((c) => String(c[1]).includes('digest wake runtime lookup failed'));
    expect(logged).toHaveLength(1);
  });

  it('allowsDigestWake on its own is unchanged', async () => {
    const podId = oid();
    await install({ agentName: 'solo', podId: oid() }, { runtime: { runtimeType: 'hosted' } });
    await expect(SchedulerService.allowsDigestWake({ agentName: 'solo', instanceId: 'default', podId }))
      .resolves.toBe(false);
    await expect(SchedulerService.allowsDigestWake({ agentName: 'solo', config: { heartbeat: { enabled: true } } }))
      .resolves.toBe(true);
    await expect(SchedulerService.allowsDigestWake({ agentName: 'other' })).resolves.toBe(true);
  });
});
