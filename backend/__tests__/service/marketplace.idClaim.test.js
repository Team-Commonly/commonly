/**
 * Publish and fork claim an installableId across the AgentRegistry write and
 * the Installable write, so two concurrent requests for one id cannot leave
 * AgentRegistry holding one request's doc and Installable the other's
 * (CodeRabbit on #4301).
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

describe('marketplace installableId claim', () => {
  let app;
  let bob;
  let alice;
  let bobAuth;
  let aliceAuth;

  const post = (path, authHeader, body) => request(app).post(`/api/marketplace${path}`)
    .set('Authorization', authHeader).send(body);

  // Holds the first AgentRegistry write for `agentName` until released, so the
  // second request deterministically arrives while the first is mid-write.
  const holdFirstRegistryWrite = (agentName) => {
    const entered = deferred();
    const release = deferred();
    const original = AgentRegistry.findOneAndUpdate.bind(AgentRegistry);
    let held = false;
    const spy = jest.spyOn(AgentRegistry, 'findOneAndUpdate').mockImplementation((filter, ...rest) => {
      if (!held && filter?.agentName === agentName) {
        held = true;
        entered.resolve();
        return release.promise.then(() => original(filter, ...rest));
      }
      return original(filter, ...rest);
    });
    return { entered: entered.promise, release: release.resolve, spy };
  };

  // Runs `first` until it is inside its registry write, then `second`, then
  // lets `first` finish. Both settle through Promise.all.
  const race = async (agentName, first, second) => {
    const hold = holdFirstRegistryWrite(agentName);
    const firstDone = first().then((r) => r);
    await hold.entered;
    const [a, b] = await Promise.all([
      firstDone,
      second().then((r) => { hold.release(); return r; }),
    ]);
    hold.spy.mockRestore();
    return [a, b];
  };

  const expectBusy = (res) => {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('installable_id_busy');
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
      () => post('/fork', aliceAuth, { sourceInstallableId: '@bob/helper', newInstallableId: '@alice/fork' }),
      () => post('/fork', aliceAuth, { sourceInstallableId: '@bob/other', newInstallableId: '@alice/fork' }),
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
      () => post('/publish', aliceAuth, publishBody('@alice/new', '1.0.0', { description: 'First.' })),
      () => post('/publish', aliceAuth, publishBody('@alice/new', '2.0.0', { description: 'Second.' })),
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

  test('a publish racing a fork of the same id: the fork wins and the publish gets 409', async () => {
    const [fork, publish] = await race(
      '@alice/x',
      () => post('/fork', aliceAuth, { sourceInstallableId: '@bob/helper', newInstallableId: '@alice/x' }),
      () => post('/publish', aliceAuth, publishBody('@alice/x', '3.0.0', { description: 'Published.' })),
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
      () => post('/publish', aliceAuth, publishBody('@alice/x', '3.0.0', { description: 'Published.' })),
      () => post('/fork', aliceAuth, { sourceInstallableId: '@bob/helper', newInstallableId: '@alice/x' }),
    );
    expect(publish.status).toBe(201);
    expectBusy(fork);
    const row = await Installable.findOne({ installableId: '@alice/x' }).lean();
    const ar = await AgentRegistry.findOne({ agentName: '@alice/x' }).lean();
    expect(row.forkedFrom?.installableId).toBeUndefined();
    expect(row.description).toBe('Published.');
    expect(ar.description).toBe('Published.');
  });

  test('a request after the winner finished sees its row and answers as before', async () => {
    await post('/fork', aliceAuth, { sourceInstallableId: '@bob/helper', newInstallableId: '@alice/fork' })
      .expect(201);
    const again = await post('/fork', aliceAuth, forkBody('@bob/other', '@alice/fork'));
    expect(again.status).toBe(409);
    expect(again.body.code).toBeUndefined();
    await expectNoClaim('@alice/fork');
  });

  test('an expired claim left by a crashed holder does not block the id', async () => {
    await SchedulerHeartbeatLease.create({
      _id: CLAIM_ID('@alice/fork'), ownerId: 'crashed', expiresAt: new Date(Date.now() - 1000),
    });
    const res = await post('/fork', aliceAuth, forkBody('@bob/helper', '@alice/fork'));
    expect(res.status).toBe(201);
    expect(res.body.warnings).toBeUndefined();
    await expectNoClaim('@alice/fork');
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
  });
});
