/**
 * A row the AgentRegistry bridge backfilled is not a marketplace listing:
 * no marketplace route can return, fork, list or manage it, and a namespace
 * owner's publish takes it over.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Installable = require('../../models/Installable');
const { AgentRegistry } = require('../../models/AgentRegistry');
const {
  sweepRegistryDrift, mirrorRegistryRow, mirrorRegistryAvatar,
} = require('../../services/installable/registryReconciler');

const JWT_SECRET = 'test-jwt-secret-marketplace-backfill';

jest.setTimeout(60000);

const manifest = (name, version = '1.0.0') => ({
  name, version, context: { required: [] }, runtime: { type: 'standalone', connection: 'rest' },
});

const publishBody = (installableId, version, extra = {}) => ({
  installableId,
  name: 'Helper',
  description: 'Helps.',
  version,
  kind: 'agent',
  components: [{ name: 'helper', type: 'agent', runtime: 'webhook' }],
  ...extra,
});

describe('marketplace routes and backfilled rows', () => {
  let app;
  let bob;
  let alice;
  let bobAuth;
  let aliceAuth;

  const browseIds = async () => {
    const res = await request(app).get('/api/marketplace/browse?limit=100');
    expect(res.status).toBe(200);
    return res.body.items.map((i) => i.installableId);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    await Installable.init();
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
    await AgentRegistry.create({
      agentName: 'byo-x',
      displayName: 'BYO X',
      description: 'A self-serve agent.',
      manifest: manifest('byo-x'),
      registry: 'private',
      ephemeral: true,
      verified: true,
      publisher: { userId: alice._id },
    });
  });

  test('a backfilled ephemeral row cannot be forked', async () => {
    await sweepRegistryDrift({ dryRun: false });
    const res = await request(app)
      .post('/api/marketplace/fork')
      .set('Authorization', bobAuth)
      .send({ sourceInstallableId: 'byo-x', newInstallableId: '@bob/byo-copy' });
    expect(res.status).toBe(404);
    expect(await Installable.countDocuments({ installableId: '@bob/byo-copy' })).toBe(0);
    expect(await AgentRegistry.countDocuments({ agentName: '@bob/byo-copy' })).toBe(0);
  });

  test('a fork of a real listing carries no registry metadata', async () => {
    await request(app).post('/api/marketplace/publish').set('Authorization', bobAuth)
      .send(publishBody('@bob/helper', '1.0.0')).expect(201);
    const res = await request(app).post('/api/marketplace/fork').set('Authorization', aliceAuth)
      .send({ sourceInstallableId: '@bob/helper', newInstallableId: '@alice/helper' });
    expect(res.status).toBe(201);
    const fork = await Installable.findOne({ installableId: '@alice/helper' }).lean();
    expect(JSON.stringify(fork.components)).not.toMatch(/registryManifest|registryRow/);
  });

  test.each([
    ['the same version', '1.0.0'],
    ['a new version with no categories or tags', '2.0.0'],
  ])('publish after a backfill, %s, is published and browsable', async (_label, version) => {
    await AgentRegistry.create({
      agentName: '@bob/helper',
      displayName: 'Helper',
      description: 'Registered first.',
      manifest: manifest('@bob/helper'),
      latestVersion: '1.0.0',
      registry: 'commonly-community',
      publisher: { userId: bob._id },
    });
    await sweepRegistryDrift({ dryRun: false });
    expect((await Installable.findOne({ installableId: '@bob/helper' }).lean()).origin).toBe('registry-backfill');

    const res = await request(app).post('/api/marketplace/publish').set('Authorization', bobAuth)
      .send(publishBody('@bob/helper', version));
    expect(res.status).toBe(201);
    expect(res.body.warnings).toBeUndefined();
    const row = await Installable.findOne({ installableId: '@bob/helper' }).lean();
    expect(row.origin).toBeUndefined();
    expect(row).toMatchObject({ source: 'marketplace', version, marketplace: { published: true } });
    expect(row.components).toHaveLength(1);
    expect(row.components[0].metadata).toBeUndefined();
    expect(await browseIds()).toEqual(['@bob/helper']);
  });

  test('the namespace owner publishes over a squatter\'s backfilled row', async () => {
    const squat = await AgentRegistry.create({
      agentName: '@bob/foo',
      displayName: 'Squatted',
      description: 'Not Bob.',
      manifest: manifest('@bob/foo'),
      registry: 'commonly-community',
      publisher: { userId: alice._id, name: 'alice' },
    });
    await mirrorRegistryRow(squat, 'test');
    const res = await request(app).post('/api/marketplace/publish').set('Authorization', bobAuth)
      .send(publishBody('@bob/foo', '1.0.0'));
    expect(res.status).toBe(201);
    const row = await Installable.findOne({ installableId: '@bob/foo' }).lean();
    expect(String(row.publisher.userId)).toBe(String(bob._id));
    expect(String(row.owner)).toBe(String(bob._id));
    expect(row.origin).toBeUndefined();
  });

  test('detail of a backfilled row is 404 to everyone, its owner included', async () => {
    await sweepRegistryDrift({ dryRun: false });
    await request(app).get('/api/marketplace/manifests/byo-x').expect(404);
    await request(app).get('/api/marketplace/manifests/byo-x').set('Authorization', bobAuth).expect(404);
    await request(app).get('/api/marketplace/manifests/byo-x').set('Authorization', aliceAuth).expect(404);
  });

  test('/mine excludes backfilled rows, and unpublish, deprecate and delete answer 404', async () => {
    await sweepRegistryDrift({ dryRun: false });
    const mine = await request(app).get('/api/marketplace/mine').set('Authorization', aliceAuth);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([]);
    await request(app).delete('/api/marketplace/publish/byo-x').set('Authorization', aliceAuth).expect(404);
    await request(app).post('/api/marketplace/publish/byo-x/deprecate').set('Authorization', aliceAuth)
      .send({ version: '1.0.0' }).expect(404);
    await request(app).delete('/api/marketplace/manifests/byo-x').set('Authorization', aliceAuth).expect(404);
    expect(await AgentRegistry.countDocuments({ agentName: 'byo-x' })).toBe(1);
    expect((await Installable.findOne({ installableId: 'byo-x' }).lean()).status).toBe('active');
  });

  test('the avatar mirror leaves a real listing unchanged', async () => {
    await request(app).post('/api/marketplace/publish').set('Authorization', bobAuth)
      .send(publishBody('@bob/helper', '1.0.0', {
        components: [{ name: 'helper', type: 'agent', persona: { avatar: 'bottts:bob' } }],
      })).expect(201);
    const before = await Installable.collection.findOne({ installableId: '@bob/helper' });
    await mirrorRegistryAvatar('@bob/helper', 'bottts:hijack');
    expect(await Installable.collection.findOne({ installableId: '@bob/helper' })).toEqual(before);
  });

  describe('every route on the marketplace router', () => {
    // A marked row of each kind, all owned by alice.
    const MARKED = [
      { agentName: 'byo-x' }, // seeded in beforeEach: ephemeral
      {
        agentName: '@alice/priv', displayName: 'Private', registry: 'private', verified: true,
      },
      {
        agentName: '@alice/smoke', displayName: 'Smoke', registry: 'commonly-community', verified: false,
      },
      {
        agentName: 'walk-official', displayName: 'Official', registry: 'commonly-official', verified: true,
      },
    ];
    const markedIds = MARKED.map((m) => m.agentName);

    // One request builder per route; a route missing here fails the walk, so a
    // new route has to be added (and proven) before it ships.
    const ROUTES = {
      'POST /publish': (who) => [{ path: '/publish', body: publishBody(`@${who}/walk-new`, '1.0.0') }],
      'DELETE /publish/:installableId(*)': () => markedIds.map((id) => ({ path: `/publish/${id}` })),
      'DELETE /manifests/:installableId(*)': () => markedIds.map((id) => ({ path: `/manifests/${id}` })),
      'POST /fork': (who) => markedIds.map((id) => ({
        path: '/fork', body: { sourceInstallableId: id, newInstallableId: `@${who}/walk-fork` },
      })),
      'POST /publish/:installableId(*)/deprecate': () => markedIds.map((id) => ({
        path: `/publish/${id}/deprecate`, body: { version: '1.0.0' },
      })),
      'GET /browse': () => [{ path: '/browse?limit=100' }, { path: '/browse?q=private' }],
      'GET /manifests/:installableId(*)/forks': () => markedIds.map((id) => ({ path: `/manifests/${id}/forks` })),
      'GET /manifests/:installableId(*)': () => markedIds.map((id) => ({ path: `/manifests/${id}` })),
      'GET /mine': () => [{ path: '/mine' }],
    };

    test('no response, to anyone, carries a backfilled row', async () => {
      for (const m of MARKED.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        await AgentRegistry.create({
          description: 'Backfilled.',
          manifest: { ...manifest(m.agentName), capabilities: [{ name: 'secret-capability' }] },
          publisher: { userId: alice._id, name: 'alice' },
          ...m,
        });
      }
      await sweepRegistryDrift({ dryRun: false });
      expect(await Installable.countDocuments({ origin: 'registry-backfill' })).toBe(MARKED.length);
      const before = await Installable.collection.find({ origin: 'registry-backfill' }).sort({ _id: 1 }).toArray();

      const router = require('../../routes/marketplace-api');
      const routes = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods)
        .map((method) => `${method.toUpperCase()} ${l.route.path}`));
      const missing = routes.filter((key) => !ROUTES[key]);
      expect({ uncallableRoutes: missing }).toEqual({ uncallableRoutes: [] });

      const callers = [['anonymous', null], ['non-owner', bobAuth], ['owner', aliceAuth]];
      for (const key of routes) {
        const method = key.split(' ')[0].toLowerCase();
        for (const [who, authHeader] of callers) {
          for (const { path: p, body } of ROUTES[key](who === 'owner' ? 'alice' : 'bob')) {
            let call = request(app)[method](`/api/marketplace${p}`);
            if (authHeader) call = call.set('Authorization', authHeader);
            // eslint-disable-next-line no-await-in-loop
            const res = await (body ? call.send(body) : call);
            const text = JSON.stringify(res.body);
            for (const id of markedIds) {
              expect({ key, who, p, leaked: text.includes(`"${id}"`) }).toEqual({ key, who, p, leaked: false });
            }
            expect({ key, who, p, metadata: /registryManifest|registryRow|secret-capability/.test(text) })
              .toEqual({ key, who, p, metadata: false });
          }
        }
      }

      expect(await Installable.collection.find({ origin: 'registry-backfill' }).sort({ _id: 1 }).toArray())
        .toEqual(before);
      expect(await AgentRegistry.countDocuments({ agentName: { $in: markedIds } })).toBe(MARKED.length);
    });

    test('only the listing facade and the two named exceptions touch the Installable model', () => {
      const source = fs.readFileSync(path.join(__dirname, '../../routes/marketplace-api.ts'), 'utf8');
      const uses = source.split('\n').filter((line) => /InstallableModel\b/.test(line)).map((l) => l.trim());
      const allowed = (line) => (
        line.startsWith('const InstallableModel = require(')
        || /^(find|findOne|countDocuments|updateOne|deleteOne|create): /.test(line)
        || line.startsWith('const findBackfillForTakeover = ')
        || line.startsWith('Boolean(await InstallableModel.findOne({ installableId }))')
      );
      expect(uses.filter((line) => !allowed(line))).toEqual([]);
      expect(source).not.toMatch(/[^A-Za-z]Installable\.[a-zA-Z]+\(/);
    });
  });
});
