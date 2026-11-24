/**
 * F597: `GET /api/agents/runtime/events?waitMs=` holds an empty poll open.
 *
 * An idle BYO agent polled every ~5 s, each poll paying auth plus an inbox
 * read. The long-poll lets it ask about once per 25 s. These cases pin the
 * contract: an event present answers at once; an empty inbox is held; an
 * enqueue wakes the hold promptly; a row that arrives without the in-process
 * signal (another backend process, a direct insert) is still found by the
 * periodic recheck; a client that goes away frees its hold and claims
 * nothing; and with no waitMs the verb behaves exactly as before.
 *
 * Real Mongo and the real install + token path, as in duplicateAnswer.test.js.
 */
process.env.PG_HOST = '';

jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit');
  const pass = () => (_req, _res, next) => next();
  return Object.assign(pass, actual, { default: pass, rateLimit: pass });
});

const http = require('http');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const waiters = require('../../services/agentEventWaiters');

const JWT_SECRET = 'long-poll-test-only';
jest.setTimeout(60000);

let app;
let server;
let baseUrl;
let person;
let personToken;
let pod;
let seatToken;

const manifest = (name) => ({
  agentName: name,
  displayName: name,
  description: 'long-poll agent',
  registry: 'commonly-official',
  verified: true,
  manifest: {
    name,
    version: '1.0.0',
    capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] },
    runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0',
  versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

const install = async (agentName) => {
  const installed = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
    .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
  expect(installed.status === 200 ? 200 : installed.body).toBe(200);
  const res = await request(app).post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
    .set('Authorization', `Bearer ${personToken}`).send({ label: `${agentName} token` });
  expect(res.status).toBe(200);
  return res.body.token;
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const poll = (query = '', token = seatToken) => request(app)
  .get(`/api/agents/runtime/events${query}`)
  .set('Authorization', `Bearer ${token}`);

const timed = async (promise) => {
  const started = Date.now();
  const res = await promise;
  return { res, ms: Date.now() - started };
};

const enqueue = (content = 'hello') => AgentEventService.enqueue({
  agentName: 'alice',
  instanceId: 'default',
  podId: pod._id,
  type: 'chat.mention',
  payload: { content, messageId: `m-${Math.random()}` },
});

// Until the hold has registered: the request is in flight before the wake.
const untilHeld = async (count = 1) => {
  for (let i = 0; i < 200 && waiters.waiterCount() < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
  expect(waiters.waiterCount()).toBe(count);
};

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  person = await User.create({ username: 'lp-person', email: 'lp-person@test.com', password: 'password123' });
  personToken = jwt.sign({ id: person._id.toString() }, JWT_SECRET);
  await AgentRegistry.create(manifest('alice'));
});

afterAll(async () => {
  await new Promise((resolve) => { server.close(resolve); });
  await closeMongoDb();
});

beforeEach(async () => {
  await Promise.all([AgentInstallation.deleteMany({}), AgentEvent.deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({
    name: 'Long', type: 'chat', createdBy: person._id, members: [person._id], 
  });
  seatToken = await install('alice');
  await AgentEvent.deleteMany({});
});

afterEach(() => {
  expect(waiters.waiterCount()).toBe(0);
  expect(waiters.heldSlotCount()).toBe(0);
  // Shutdown waits on this count (hostedShutdownService): it must not leak.
  expect(waiters.heldPollCount()).toBe(0);
});

describe('clampWaitMs', () => {
  test('absent, zero, negative or junk means no hold; large values clamp to 25s', () => {
    expect(waiters.clampWaitMs(undefined)).toBe(0);
    expect(waiters.clampWaitMs('')).toBe(0);
    expect(waiters.clampWaitMs('0')).toBe(0);
    expect(waiters.clampWaitMs('-5')).toBe(0);
    expect(waiters.clampWaitMs('abc')).toBe(0);
    expect(waiters.clampWaitMs(['1000'])).toBe(0);
    expect(waiters.clampWaitMs('1500')).toBe(1500);
    expect(waiters.clampWaitMs('600000')).toBe(waiters.MAX_WAIT_MS);
    expect(waiters.MAX_WAIT_MS).toBe(25000);
  });
});

describe('GET /events?waitMs', () => {
  test('an event already pending answers at once, claimed as before', async () => {
    const event = await enqueue('already here');
    const { res, ms } = await timed(poll('?waitMs=5000'));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(1000);
    expect(res.body.events.map((e) => String(e._id))).toEqual([String(event._id)]);
    const row = await AgentEvent.findById(event._id).lean();
    expect(row.status).toBe('delivered');
    expect(res.body.events[0].payload.deliveryId).toBe(row.deliveryNonce);
  });

  test('an empty inbox is held, and an enqueue during the hold answers promptly', async () => {
    const pending = timed(poll('?waitMs=10000'));
    await untilHeld();
    await sleep(300);
    const event = await enqueue('arrived mid-hold');
    const { res, ms } = await pending;
    expect(res.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThan(2000);
    expect(res.body.events.map((e) => String(e._id))).toEqual([String(event._id)]);
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
  });

  test('an empty hold that times out answers empty after about waitMs', async () => {
    const { res, ms } = await timed(poll('?waitMs=700'));
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(ms).toBeGreaterThanOrEqual(650);
    expect(ms).toBeLessThan(2500);
  });

  test('a row inserted without the in-process signal is found by the recheck', async () => {
    const pending = timed(poll('?waitMs=10000'));
    await untilHeld();
    // Another backend process's enqueue: a row lands, nothing here is told.
    const row = await AgentEvent.create({
      agentName: 'alice',
      instanceId: 'default',
      podId: pod._id,
      type: 'chat.mention',
      payload: { content: 'from another process' },
    });
    const { res, ms } = await pending;
    expect(res.body.events.map((e) => String(e._id))).toEqual([String(row._id)]);
    expect(ms).toBeLessThan(waiters.RECHECK_INTERVAL_MS + 1500);
  });

  test('a digest-only inbox does not end the hold (it is not a wake)', async () => {
    const pending = timed(poll('?waitMs=800'));
    await untilHeld();
    await AgentEventService.enqueue({
      agentName: 'alice',
      instanceId: 'default',
      podId: pod._id,
      type: 'chat.mention',
      payload: { content: 'ambient', messageId: 'digest-1' },
      deliveryMode: 'digest',
    });
    const { res, ms } = await pending;
    expect(res.body.events).toEqual([]);
    expect(ms).toBeGreaterThanOrEqual(750);
  });

  test('a client that disconnects frees its hold and claims nothing', async () => {
    const req = http.get(`${baseUrl}/api/agents/runtime/events?waitMs=10000`, {
      headers: { Authorization: `Bearer ${seatToken}` },
    });
    req.on('error', () => {});
    await untilHeld();
    req.destroy();
    for (let i = 0; i < 100 && waiters.waiterCount() > 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    expect(waiters.waiterCount()).toBe(0);
    expect(waiters.heldSlotCount()).toBe(0);
    const event = await enqueue('after the client left');
    await sleep(200);
    // Nobody returned it, so nobody may have marked it delivered.
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
  });

  test('a claim the client left before receiving is put back exactly (unclaimUnsent)', async () => {
    const event = await enqueue('claimed, never sent');
    const res = await poll('');
    expect(res.body.events).toHaveLength(1);
    const before = await AgentEvent.findById(event._id).lean();
    expect(before).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(await AgentEventService.unclaimUnsent(res.body.events)).toBe(1);
    const after = await AgentEvent.findById(event._id).lean();
    expect(after).toMatchObject({ status: 'pending', attempts: 0, deliveryNonce: null });
    // Fenced on the nonce: a second put-back, or one for a re-claimed row, is a no-op.
    expect(await AgentEventService.unclaimUnsent(res.body.events)).toBe(0);
    const again = await poll('');
    expect(again.body.events.map((e) => String(e._id))).toEqual([String(event._id)]);
    expect(await AgentEventService.unclaimUnsent(res.body.events)).toBe(0);
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('delivered');
  });

  test('a released delivery wakes a held poll', async () => {
    const event = await enqueue('handed back');
    const first = await poll('');
    const { deliveryId } = first.body.events[0].payload;
    const pending = timed(poll('?waitMs=10000'));
    await untilHeld();
    expect(await AgentEventService.releaseDelivery(String(event._id), 'alice', 'default', deliveryId)).toBe('released');
    const { res, ms } = await pending;
    expect(res.body.events.map((e) => String(e._id))).toEqual([String(event._id)]);
    expect(ms).toBeLessThan(1500);
  });

  test('a token holds at most MAX_WAITERS_PER_TOKEN polls; the next answers at once', async () => {
    const held = [];
    for (let i = 0; i < waiters.MAX_WAITERS_PER_TOKEN; i += 1) held.push(poll('?waitMs=1500'));
    // supertest sends lazily: .then() starts each request.
    const settled = held.map((p) => p.then((r) => r));
    await untilHeld(waiters.MAX_WAITERS_PER_TOKEN);
    const { res, ms } = await timed(poll('?waitMs=1500'));
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(ms).toBeLessThan(1000);
    await Promise.all(settled);
  });

  test('only the hold that returns an event claims it: one event, two holds, one delivery', async () => {
    const otherToken = (await request(app).post(`/api/registry/pods/${pod._id}/agents/alice/runtime-tokens`)
      .set('Authorization', `Bearer ${personToken}`).send({ label: 'second' })).body.token;
    // Both holds reach the DB claim together: each post-wake claim waits at a
    // barrier until the other has arrived, then both race the real claim.
    const real = AgentEventService.listInboxPage.bind(AgentEventService);
    let arrived = 0;
    let openBarrier;
    const barrier = new Promise((resolve) => { openBarrier = resolve; });
    let held = false;
    const spy = jest.spyOn(AgentEventService, 'listInboxPage').mockImplementation(async (options) => {
      if (held) {
        arrived += 1;
        if (arrived === 2) openBarrier();
        await barrier;
      }
      return real(options);
    });
    try {
      const a = timed(poll('?waitMs=3000'));
      const b = timed(poll('?waitMs=3000', otherToken));
      await untilHeld(2);
      held = true;
      const event = await enqueue('one for two');
      const [ra, rb] = await Promise.all([a, b]);
      expect(arrived).toBeGreaterThanOrEqual(2);
      const returned = [...ra.res.body.events, ...rb.res.body.events];
      expect(returned.map((e) => String(e._id))).toEqual([String(event._id)]);
      const row = await AgentEvent.findById(event._id).lean();
      expect(row.status).toBe('delivered');
      expect(row.attempts).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a carry refresh (onlyIds) is never held', async () => {
    const { res, ms } = await timed(poll('?waitMs=5000&onlyIds=0123456789abcdef01234567'));
    expect(res.body.events).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });
});

describe('GET /events without waitMs', () => {
  test('an empty inbox answers at once, with no hold, exactly as before', async () => {
    const { res, ms } = await timed(poll(''));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], inboxCount: 0 });
    expect(ms).toBeLessThan(1000);
    expect(waiters.waiterCount()).toBe(0);
  });

  test('waitMs=0 is the same as absent', async () => {
    const { res, ms } = await timed(poll('?waitMs=0'));
    expect(res.body).toEqual({ events: [], inboxCount: 0 });
    expect(ms).toBeLessThan(1000);
  });
});

describe('the enqueue path wakes holds', () => {
  test('notifyAgentEventWaiters fires for the enqueued identity only', async () => {
    const woken = [];
    const end = waiters.waitForAgentEvent({
      agentName: 'Alice',
      instanceId: 'default',
      timeoutMs: 2000,
      hasPending: async () => false,
      onClose: () => () => {},
    }).then((o) => woken.push(['alice', o]));
    const other = waiters.waitForAgentEvent({
      agentName: 'bob',
      instanceId: 'default',
      timeoutMs: 300,
      hasPending: async () => false,
      onClose: () => () => {},
    }).then((o) => woken.push(['bob', o]));
    await enqueue('for alice');
    await Promise.all([end, other]);
    expect(woken).toEqual(expect.arrayContaining([['alice', 'woken'], ['bob', 'timeout']]));
  });

  test('endAllWaits answers every hold and refuses new ones until reset', async () => {
    const pending = timed(poll('?waitMs=10000'));
    await untilHeld();
    waiters.endAllWaits();
    const { res, ms } = await pending;
    expect(res.body.events).toEqual([]);
    expect(ms).toBeLessThan(1500);
    const after = await timed(poll('?waitMs=10000'));
    expect(after.ms).toBeLessThan(1000);
    waiters.resetWaitersForTests();
  });
});

describe('a hold re-checks its credential before the claim a wake leads to', () => {
  // eslint-disable-next-line global-require
  const { hash } = require('../../utils/secret');
  // eslint-disable-next-line global-require
  const { revokeRuntimeTokenEverywhere } = require('../../routes/registry/tokens');

  test('a token revoked mid-hold is refused, and the event stays pending for a valid poll', async () => {
    const pending = timed(poll('?waitMs=8000'));
    await untilHeld();
    await revokeRuntimeTokenEverywhere(hash(seatToken));
    const event = await enqueue('arrived after the revoke');
    const { res, ms } = await pending;
    expect(res.status).toBe(401);
    expect(res.body.events).toBeUndefined();
    expect(ms).toBeLessThan(2000);
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
    // A fresh request with the revoked token is refused the same way.
    expect((await poll('')).status).toBe(401);
    const freshToken = (await request(app).post(`/api/registry/pods/${pod._id}/agents/alice/runtime-tokens`)
      .set('Authorization', `Bearer ${personToken}`).send({ label: 'fresh' })).body.token;
    const next = await poll('', freshToken);
    expect(next.body.events.map((e) => String(e._id))).toEqual([String(event._id)]);
  });

  test('an installation made inactive mid-hold is refused, with nothing claimed', async () => {
    const pending = timed(poll('?waitMs=8000'));
    await untilHeld();
    await AgentInstallation.updateMany({ agentName: 'alice' }, { $set: { status: 'uninstalled' } });
    const event = await enqueue('arrived after the uninstall');
    const { res } = await pending;
    expect(res.status).toBe(401);
    expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
    expect((await poll('')).status).toBe(401);
  });

  test('a still-valid token claims as before after the re-check', async () => {
    const pending = timed(poll('?waitMs=8000'));
    await untilHeld();
    const event = await enqueue('still allowed');
    const { res } = await pending;
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => String(e._id))).toEqual([String(event._id)]);
  });
});

describe('shutdown reaches a hold that is mid-claim', () => {
  test('a woken hold whose row a sibling won does not wait again once shutdown began', async () => {
    const real = AgentEventService.listInboxPage.bind(AgentEventService);
    let calls = 0;
    const spy = jest.spyOn(AgentEventService, 'listInboxPage').mockImplementation(async (options) => {
      calls += 1;
      if (calls === 2) {
        // Shutdown fires while this hold is claiming, and a sibling won the row.
        waiters.endAllWaits();
        return { events: [], inboxCount: 0 };
      }
      return real(options);
    });
    try {
      const pending = timed(poll('?waitMs=8000'));
      await untilHeld();
      waiters.notifyAgentEventWaiters('alice', 'default');
      const { res, ms } = await pending;
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
      expect(ms).toBeLessThan(1500);
    } finally {
      spy.mockRestore();
      waiters.resetWaitersForTests();
    }
  });
});

describe('after a wake the hold claims from the scope a fresh request would have', () => {
  // eslint-disable-next-line global-require
  const { hash } = require('../../utils/secret');

  const enqueueIn = (podId, content) => AgentEventService.enqueue({
    agentName: 'alice', instanceId: 'default', podId, type: 'chat.mention',
    payload: { content, messageId: `m-${Math.random()}` },
  });

  test('a pod uninstalled mid-hold drops out: only the remaining pod\'s event is returned', async () => {
    const podB = await Pod.create({ name: 'Second', type: 'chat', createdBy: person._id, members: [person._id] });
    const installedB = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
      .send({ agentName: 'alice', podId: podB._id.toString(), scopes: ['context:read'] });
    expect(installedB.status).toBe(200);
    const pending = timed(poll('?waitMs=8000'));
    await untilHeld();
    await AgentInstallation.updateOne({ agentName: 'alice', podId: pod._id }, { $set: { status: 'uninstalled' } });
    const inA = await enqueueIn(pod._id, 'for the removed pod');
    await sleep(100);
    const inB = await enqueueIn(podB._id, 'for the remaining pod');
    const { res } = await pending;
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => String(e._id))).toEqual([String(inB._id)]);
    expect((await AgentEvent.findById(inA._id).lean()).status).toBe('pending');
  });

  test('a cloud entitlement lost mid-hold is refused like a fresh request, with nothing claimed', async () => {
    // eslint-disable-next-line global-require
    const ownership = require('../../services/cloudRuntimeOwnership');
    const pending = timed(poll('?waitMs=8000'));
    await untilHeld();
    const spy = jest.spyOn(ownership, 'cloudRuntimeMayRun').mockResolvedValue(false);
    try {
      const event = await enqueue('after the entitlement went');
      const { res } = await pending;
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ownership.CLOUD_RUN_REFUSED_REASON);
      expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
      expect((await poll('')).status).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });

  test('a spawn token whose bot User is gone mid-hold is refused; a valid one keeps working', async () => {
    // eslint-disable-next-line global-require
    const { resolveSeatCredential, mintSpawnCredential } = require('../../services/spawnCredentialService');
    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': 'alice' });
    const seatRow = await resolveSeatCredential({ tokenHash: hash(seatToken), agentUserId: bot._id });
    const minted = await mintSpawnCredential({
      seat: seatRow, spawnId: 'long-poll-spawn', ttlSeconds: 600, identity: { agentName: 'alice', instanceId: 'default' },
    });
    expect(minted.ok).toBe(true);
    // A valid ledger-only token: held, woken, claims.
    const first = timed(poll('?waitMs=8000', minted.token));
    await untilHeld();
    const claimed = await enqueue('for the spawn');
    expect((await first).res.body.events.map((e) => String(e._id))).toEqual([String(claimed._id)]);

    const pending = timed(poll('?waitMs=8000', minted.token));
    await untilHeld();
    await User.updateOne({ _id: bot._id }, { $set: { isBot: false } });
    try {
      const event = await enqueue('after the bot User went');
      const { res } = await pending;
      expect(res.status).toBe(401);
      expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
      expect((await poll('', minted.token)).status).toBe(401);
    } finally {
      await User.updateOne({ _id: bot._id }, { $set: { isBot: true } });
    }
  });

  test('a client that leaves after the claim and before the answer gets its rows put back', async () => {
    const real = AgentEventService.listInboxPage.bind(AgentEventService);
    let clientReq;
    let held = false;
    const spy = jest.spyOn(AgentEventService, 'listInboxPage').mockImplementation(async (options) => {
      const page = await real(options);
      if (held && page.events.length) {
        // The claim is made; the client goes away before the answer is sent.
        clientReq.destroy();
        await sleep(100);
      }
      return page;
    });
    try {
      clientReq = http.get(`${baseUrl}/api/agents/runtime/events?waitMs=8000`, {
        headers: { Authorization: `Bearer ${seatToken}` },
      });
      clientReq.on('error', () => {});
      await untilHeld();
      held = true;
      const event = await enqueue('claimed, then nobody there');
      for (let i = 0; i < 100 && waiters.heldPollCount() > 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(10);
      }
      await sleep(100);
      const row = await AgentEvent.findById(event._id).lean();
      expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});
