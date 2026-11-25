/**
 * Publish and fork claim an installableId across the AgentRegistry write and
 * the Installable write, so two concurrent requests for one id cannot leave
 * AgentRegistry holding one request's doc and Installable the other's
 * (CodeRabbit on #4301). The claim is re-confirmed before each write, so a
 * holder whose claim expired writes nothing.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Installable = require('../../models/Installable');
const SchedulerHeartbeatLease = require('../../models/SchedulerHeartbeatLease');
const { AgentRegistry } = require('../../models/AgentRegistry');

const JWT_SECRET = 'test-jwt-secret-marketplace-id-claim';
const CLAIM_ID = (id) => `installable-claim:${id}`;

jest.setTimeout(60000);

const publishBody = (installableId, version = '1.0.0', extra = {}) => ({
  installableId,
  name: 'Helper',
  description: 'Helps.',
  version,
  kind: 'agent',
  components: [{ name: 'helper', type: 'agent', runtime: 'webhook' }],
  ...extra,
});

const forkBody = (sourceInstallableId, newInstallableId) => ({ sourceInstallableId, newInstallableId });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Resolves 'barrier' if `entered` fires first, or throws if the request
// answered without ever reaching it, so a broken hook fails instead of hanging.
const reachBarrier = async (entered, response, what) => {
  const reached = await Promise.race([
    entered.then(() => 'barrier'),
    response.then(() => 'responded', () => 'responded'),
  ]);
  if (reached !== 'barrier') throw new Error(`${what} responded before reaching its barrier`);
};

describe('marketplace installableId claim', () => {
  let app;
  let bob;
  let alice;
  let bobAuth;
  let aliceAuth;

  const post = (path, authHeader, body) => request(app).post(`/api/marketplace${path}`)
    .set('Authorization', authHeader).send(body);
  // A real promise, started once (a supertest Test sends again on each then).
  const send = (path, authHeader, body) => Promise.resolve(post(path, authHeader, body));

  // Holds the first call of `obj[method]` that `match` accepts until released.
  // With `after`, the original call runs first and the hold is on its result.
  const holdFirst = (obj, method, match, { after = false } = {}) => {
    const entered = deferred();
    const gate = deferred();
    const original = obj[method].bind(obj);
    let held = false;
    const spy = jest.spyOn(obj, method).mockImplementation((...args) => {
      if (held || !match(...args)) return original(...args);
      held = true;
      if (after) {
        return Promise.resolve(original(...args)).then(async (result) => {
          entered.resolve();
          await gate.promise;
          return result;
        });
      }
      entered.resolve();
      return gate.promise.then(() => original(...args));
    });
    return { entered: entered.promise, release: gate.resolve, spy };
  };

  const holdFirstRegistryWrite = (agentName) => holdFirst(
    AgentRegistry, 'findOneAndUpdate', (filter) => filter?.agentName === agentName,
  );

  // Starts `first`, holds it inside its registry write, runs `second` to the
  // end, calls `whilePaused` while `first` is still held, then lets it finish.
  const race = async (agentName, first, second, whilePaused) => {
    const hold = holdFirstRegistryWrite(agentName);
    const started = [];
    try {
      const firstDone = first();
      started.push(firstDone);
      await reachBarrier(hold.entered, firstDone, 'the first request');
      const secondDone = second();
      started.push(secondDone);
      const b = await secondDone;
      await whilePaused(b);
      hold.release();
      return [await firstDone, b];
    } finally {
      hold.release();
      await Promise.allSettled(started);
      hold.spy.mockRestore();
    }
  };

  const expectBusy = (res) => {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('installable_id_busy');
  };

  const rawRows = async (id) => ({
    ar: await AgentRegistry.collection.findOne({ agentName: id }),
    installable: await Installable.collection.findOne({ installableId: id }),
  });

  const expectLoserWroteNothing = (id, before = { ar: null, installable: null }) => async (loser) => {
    expectBusy(loser);
    expect(await rawRows(id)).toEqual(before);
  };

  const expectNoClaim = async (id) => {
    expect(await SchedulerHeartbeatLease.countDocuments({ _id: CLAIM_ID(id) })).toBe(0);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    await Installable.init();
    await SchedulerHeartbeatLease.init();
    app = express();
    app.use(express.json());
    app.use('/api/marketplace', require('../../routes/marketplace-api'));
  });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    bob = await User.create({ username: 'bob', email: 'bob@test.com', password: 'password123' });
    alice = await User.create({ username: 'alice', email: 'alice@test.com', password: 'password123' });
    bobAuth = `Bearer ${jwt.sign({ id: bob._id }, JWT_SECRET)}`;
    aliceAuth = `Bearer ${jwt.sign({ id: alice._id }, JWT_SECRET)}`;
    await post('/publish', bobAuth, publishBody('@bob/helper', '1.0.0', { description: 'Bob helps.' })).expect(201);
    await post('/publish', bobAuth, publishBody('@bob/other', '1.0.0', { name: 'Other', description: 'Other.' }))
      .expect(201);
  });

  test('two concurrent forks onto one new id: one 201, one 409, both tables hold the winner', async () => {
    const [first, second] = await race(
      '@alice/fork',
      () => send('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork')),
      () => send('/fork', aliceAuth, forkBody('@bob/other', '@alice/fork')),
      expectLoserWroteNothing('@alice/fork'),
    );
    expect(first.status).toBe(201);
    expect(first.body.warnings).toBeUndefined();
    expectBusy(second);

    const row = await Installable.findOne({ installableId: '@alice/fork' }).lean();
    const ar = await AgentRegistry.findOne({ agentName: '@alice/fork' }).lean();
    expect(row.forkedFrom.installableId).toBe('@bob/helper');
    expect(row.description).toBe('Bob helps.');
    expect(ar.description).toBe('Bob helps.');
    expect(ar.displayName).toBe(row.name);
    expect(await Installable.countDocuments({ installableId: '@alice/fork' })).toBe(1);
    expect((await Installable.findOne({ installableId: '@bob/helper' }).lean()).stats.forkCount).toBe(1);
    expect((await Installable.findOne({ installableId: '@bob/other' }).lean()).stats.forkCount).toBe(0);
    await expectNoClaim('@alice/fork');
  });

  test('two concurrent publishes of one new id: one 201, one 409, both tables hold the winner', async () => {
    const [first, second] = await race(
      '@alice/new',
      () => send('/publish', aliceAuth, publishBody('@alice/new', '1.0.0', { description: 'First.' })),
      () => send('/publish', aliceAuth, publishBody('@alice/new', '2.0.0', { description: 'Second.' })),
      expectLoserWroteNothing('@alice/new'),
    );
    expect(first.status).toBe(201);
    expect(first.body.warnings).toBeUndefined();
    expectBusy(second);

    const row = await Installable.findOne({ installableId: '@alice/new' }).lean();
    const ar = await AgentRegistry.findOne({ agentName: '@alice/new' }).lean();
    expect(row).toMatchObject({ description: 'First.', version: '1.0.0' });
    expect(ar).toMatchObject({ description: 'First.', latestVersion: '1.0.0' });
    await expectNoClaim('@alice/new');
  });

  test('two concurrent version publishes to a listing: the loser leaves the pre-race rows untouched', async () => {
    await post('/publish', aliceAuth, publishBody('@alice/x', '1.0.0', { description: 'Original.' })).expect(201);
    const before = await rawRows('@alice/x');
    const [first, second] = await race(
      '@alice/x',
      () => send('/publish', aliceAuth, publishBody('@alice/x', '2.0.0', { description: 'Two.' })),
      () => send('/publish', aliceAuth, publishBody('@alice/x', '3.0.0', { description: 'Three.' })),
      expectLoserWroteNothing('@alice/x', before),
    );
    expect(first.status).toBe(200);
    expectBusy(second);
    const row = await Installable.findOne({ installableId: '@alice/x' }).lean();
    const ar = await AgentRegistry.findOne({ agentName: '@alice/x' }).lean();
    expect(row).toMatchObject({ description: 'Two.', version: '2.0.0' });
    expect(row.versions.map((v) => v.version)).toEqual(['1.0.0', '2.0.0']);
    expect(ar).toMatchObject({ description: 'Two.', latestVersion: '2.0.0' });
  });

  test('a publish racing a fork of the same id: the fork wins and the publish gets 409', async () => {
    const [fork, publish] = await race(
      '@alice/x',
      () => send('/fork', aliceAuth, forkBody('@bob/helper', '@alice/x')),
      () => send('/publish', aliceAuth, publishBody('@alice/x', '3.0.0', { description: 'Published.' })),
      expectLoserWroteNothing('@alice/x'),
    );
    expect(fork.status).toBe(201);
    expect(fork.body.warnings).toBeUndefined();
    expectBusy(publish);
    const row = await Installable.findOne({ installableId: '@alice/x' }).lean();
    const ar = await AgentRegistry.findOne({ agentName: '@alice/x' }).lean();
    expect(row.forkedFrom.installableId).toBe('@bob/helper');
    expect(ar.description).toBe('Bob helps.');
    expect(ar.latestVersion).toBe('1.0.0');
  });

  test('a fork racing a publish of the same id: the publish wins and the fork gets 409', async () => {
    const [publish, fork] = await race(
      '@alice/x',
      () => send('/publish', aliceAuth, publishBody('@alice/x', '3.0.0', { description: 'Published.' })),
      () => send('/fork', aliceAuth, forkBody('@bob/helper', '@alice/x')),
      expectLoserWroteNothing('@alice/x'),
    );
    expect(publish.status).toBe(201);
    expectBusy(fork);
    const row = await Installable.findOne({ installableId: '@alice/x' }).lean();
    const ar = await AgentRegistry.findOne({ agentName: '@alice/x' }).lean();
    expect(row.forkedFrom?.installableId).toBeUndefined();
    expect(row.description).toBe('Published.');
    expect(ar.description).toBe('Published.');
  });

  test('a holder whose claim expired before its registry write answers 409 and writes nothing', async () => {
    // Hold fork A just after its admission read (the id-taken check).
    const hold = holdFirst(
      Installable,
      'findOne',
      (filter) => filter && Object.keys(filter).length === 1 && filter.installableId === '@alice/x',
      { after: true },
    );
    const started = [];
    try {
      const forkA = send('/fork', aliceAuth, forkBody('@bob/helper', '@alice/x'));
      started.push(forkA);
      await reachBarrier(hold.entered, forkA, 'fork A');
      // A stalls past its claim; B takes the id over and commits.
      await SchedulerHeartbeatLease.updateOne(
        { _id: CLAIM_ID('@alice/x') }, { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      const publishB = send('/publish', aliceAuth, publishBody('@alice/x', '3.0.0', { description: 'Published.' }));
      started.push(publishB);
      const b = await publishB;
      expect(b.status).toBe(201);
      const afterB = await rawRows('@alice/x');

      hold.release();
      const a = await forkA;
      expectBusy(a);
      expect(a.body.error).toMatch(/expired/);
      expect(await rawRows('@alice/x')).toEqual(afterB);
      expect(afterB.ar.description).toBe('Published.');
      expect(afterB.installable.description).toBe('Published.');
      expect(afterB.installable.forkedFrom).toBeUndefined();
      expect((await Installable.findOne({ installableId: '@bob/helper' }).lean()).stats.forkCount).toBe(0);
    } finally {
      hold.release();
      await Promise.allSettled(started);
      hold.spy.mockRestore();
    }
  });

  test('a request after the winner finished sees its row and answers as before', async () => {
    await post('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork')).expect(201);
    const again = await post('/fork', aliceAuth, forkBody('@bob/other', '@alice/fork'));
    expect(again.status).toBe(409);
    expect(again.body.code).toBeUndefined();
    await expectNoClaim('@alice/fork');
  });

  test('an expired claim left by a crashed holder is taken over in place, not re-inserted', async () => {
    const seededAt = new Date(Date.now() - 3600_000);
    await SchedulerHeartbeatLease.collection.insertOne({
      _id: CLAIM_ID('@alice/fork'),
      ownerId: 'crashed',
      expiresAt: new Date(Date.now() - 1000),
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    const hold = holdFirstRegistryWrite('@alice/fork');
    const started = [];
    try {
      const res = send('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork'));
      started.push(res);
      await reachBarrier(hold.entered, res, 'the fork');
      const claim = await SchedulerHeartbeatLease.collection.findOne({ _id: CLAIM_ID('@alice/fork') });
      expect(claim._id).toBe(CLAIM_ID('@alice/fork'));
      expect(claim.createdAt).toEqual(seededAt);
      expect(claim.ownerId).not.toBe('crashed');
      expect(claim.expiresAt.getTime()).toBeGreaterThan(Date.now());
      hold.release();
      const done = await res;
      expect(done.status).toBe(201);
      expect(done.body.warnings).toBeUndefined();
      await expectNoClaim('@alice/fork');
    } finally {
      hold.release();
      await Promise.allSettled(started);
      hold.spy.mockRestore();
    }
  });

  test('a live claim held by another request answers 409 and writes nothing', async () => {
    await SchedulerHeartbeatLease.create({
      _id: CLAIM_ID('@alice/fork'), ownerId: 'other', expiresAt: new Date(Date.now() + 30_000),
    });
    const res = await post('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork'));
    expectBusy(res);
    expect(await AgentRegistry.countDocuments({ agentName: '@alice/fork' })).toBe(0);
    expect(await Installable.countDocuments({ installableId: '@alice/fork' })).toBe(0);
    // The other holder's claim stays; only an owner releases its own.
    expect(await SchedulerHeartbeatLease.countDocuments({ _id: CLAIM_ID('@alice/fork') })).toBe(1);
  });

  describe('the claim is released', () => {
    test('after a fork drift warning', async () => {
      const spy = jest.spyOn(Installable, 'create').mockRejectedValueOnce(new Error('catalog down'));
      const res = await post('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork'));
      spy.mockRestore();
      expect(res.status).toBe(201);
      expect(res.body.warnings).toHaveLength(1);
      await expectNoClaim('@alice/fork');
    });

    test('after a publish drift warning', async () => {
      const spy = jest.spyOn(Installable, 'create').mockRejectedValueOnce(new Error('catalog down'));
      const res = await post('/publish', aliceAuth, publishBody('@alice/new'));
      spy.mockRestore();
      expect(res.status).toBe(201);
      expect(res.body.warnings).toHaveLength(1);
      await expectNoClaim('@alice/new');
    });

    test('after a 4xx', async () => {
      await post('/publish', aliceAuth, publishBody('@alice/mine')).expect(201);
      const fork = await post('/fork', aliceAuth, forkBody('@bob/helper', '@alice/mine'));
      expect(fork.status).toBe(409);
      await expectNoClaim('@alice/mine');
    });

    test('after a thrown error', async () => {
      const spy = jest.spyOn(Installable, 'findOne').mockRejectedValueOnce(new Error('mongo down'));
      const res = await post('/publish', aliceAuth, publishBody('@alice/new'));
      spy.mockRestore();
      expect(res.status).toBe(500);
      await expectNoClaim('@alice/new');
    });

    test('before the drift-warning response goes out', async () => {
      const createSpy = jest.spyOn(Installable, 'create').mockRejectedValueOnce(new Error('catalog down'));
      const hold = holdFirst(SchedulerHeartbeatLease, 'deleteOne', (filter) => filter?._id === CLAIM_ID('@alice/fork'));
      const started = [];
      try {
        const res = send('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork'));
        started.push(res);
        await reachBarrier(hold.entered, res, 'the fork');
        const state = await Promise.race([res.then(() => 'sent'), sleep(150).then(() => 'pending')]);
        expect(state).toBe('pending');
        hold.release();
        const done = await res;
        expect(done.status).toBe(201);
        expect(done.body.warnings).toEqual([expect.stringMatching(/not yet browsable/)]);
        await expectNoClaim('@alice/fork');
      } finally {
        hold.release();
        await Promise.allSettled(started);
        hold.spy.mockRestore();
        createSpy.mockRestore();
      }
    });

    test('a failed delete is retried, then the warning tells the client to wait', async () => {
      const createSpy = jest.spyOn(Installable, 'create').mockRejectedValueOnce(new Error('catalog down'));
      const delSpy = jest.spyOn(SchedulerHeartbeatLease, 'deleteOne').mockRejectedValue(new Error('mongo down'));
      try {
        const res = await post('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork'));
        expect(res.status).toBe(201);
        expect(res.body.warnings).toEqual([
          expect.stringMatching(/not yet browsable/),
          expect.stringMatching(/wait about 30 seconds/),
        ]);
        expect(delSpy).toHaveBeenCalledTimes(3);
      } finally {
        delSpy.mockRestore();
        createSpy.mockRestore();
      }
      // The leftover claim is this request's own; expiry frees it.
      expect(await SchedulerHeartbeatLease.countDocuments({ _id: CLAIM_ID('@alice/fork') })).toBe(1);
    });
  });
});
