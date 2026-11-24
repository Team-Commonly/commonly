/**
 * sweepRegistryDrift against real Mongo: insert-only, idempotent, and blind to
 * every identity table (ADR-001 identity continuity).
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const Installable = require('../../models/Installable');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const { sweepRegistryDrift, mirrorRegistryRow } = require('../../services/installable/registryReconciler');

jest.setTimeout(60000);

const ownerId = new mongoose.Types.ObjectId();

const manifest = (name, runtime = {}) => ({
  name,
  version: '1.0.0',
  context: { required: ['context:read'] },
  runtime: { type: 'standalone', connection: 'rest', ...runtime },
});

const seed = async () => {
  await AgentRegistry.create([
    {
      agentName: 'good-agent',
      displayName: 'Good Agent',
      description: 'Verified and active.',
      manifest: manifest('good-agent', { runtimeType: 'native' }),
      latestVersion: '1.0.0',
      registry: 'commonly-community',
      verified: true,
      categories: ['productivity'],
    },
    {
      agentName: 'smoke-seat',
      displayName: 'Smoke Seat',
      description: 'An internal smoke-test seat.',
      manifest: manifest('smoke-seat'),
      registry: 'commonly-community',
      verified: false,
    },
    {
      agentName: 'byo-x',
      displayName: 'BYO X',
      description: 'A self-serve agent.',
      manifest: manifest('byo-x'),
      registry: 'private',
      ephemeral: true,
      publisher: { userId: ownerId },
    },
    {
      agentName: 'newshound',
      displayName: 'NewsHound',
      description: 'Parked moltbot agent.',
      manifest: manifest('newshound', { runtimeType: 'moltbot' }),
      registry: 'commonly-official',
      verified: true,
    },
    {
      agentName: '@alice/listed',
      displayName: 'Registry copy',
      description: 'Dual-written by marketplace publish.',
      manifest: manifest('@alice/listed'),
      registry: 'commonly-community',
      status: 'deprecated',
      stats: { installs: 9 },
    },
  ]);
  await Installable.create({
    installableId: '@alice/listed',
    name: 'Marketplace Name',
    description: 'The marketplace copy wins.',
    version: '3.0.0',
    kind: 'agent',
    source: 'marketplace',
    scope: 'pod',
    components: [{ name: 'listed', type: 'agent', runtime: 'webhook' }],
    marketplace: { published: true, category: 'dev', tags: ['x'] },
    publisher: { userId: ownerId, name: 'alice' },
    status: 'active',
    stats: { totalInstalls: 5, activeInstalls: 1, forkCount: 0 },
  });
  // Raw identity rows: compared byte-for-byte before and after.
  const podId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    username: 'good-agent-bot', isBot: true, botMetadata: { agentName: 'good-agent' },
  });
  await Pod.collection.insertOne({ _id: podId, name: 'P', type: 'chat', members: [ownerId] });
  const identity = { agentName: 'good-agent', podId, instanceId: 'default' };
  await AgentInstallation.collection.insertOne({ ...identity, status: 'active' });
  await AgentProfile.collection.insertOne({ ...identity, purpose: 'p' });
};

const snapshot = async () => {
  const read = (model) => model.collection.find({}).sort({ _id: 1 }).toArray();
  return {
    users: await read(User),
    pods: await read(Pod),
    installations: await read(AgentInstallation),
    profiles: await read(AgentProfile),
    registry: await read(AgentRegistry),
  };
};

describe('sweepRegistryDrift', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Installable.init();
  });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    await seed();
  });

  test('the first run inserts the missing rows; a second run writes nothing', async () => {
    const first = await sweepRegistryDrift({ dryRun: false });
    expect(first).toMatchObject({
      scanned: 5, inserted: 4, existing: 1, errors: 0, mismatches: { status: 1, stats: 1 },
    });
    expect(await Installable.countDocuments()).toBe(5);
    const moltbot = await Installable.findOne({ installableId: 'newshound' }).lean();
    expect(moltbot.components[0].runtime).toBe('moltbot');

    const before = await Installable.collection.find({}).sort({ _id: 1 }).toArray();
    const second = await sweepRegistryDrift({ dryRun: false });
    expect(second).toMatchObject({ scanned: 5, inserted: 0, existing: 5 });
    expect(await Installable.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  test('an existing marketplace Installable is left byte-identical, and nothing is deleted', async () => {
    const before = await Installable.collection.findOne({ installableId: '@alice/listed' });
    await sweepRegistryDrift({ dryRun: false });
    expect(await Installable.collection.findOne({ installableId: '@alice/listed' })).toEqual(before);
    expect(await AgentRegistry.countDocuments()).toBe(5);
  });

  test('User, AgentInstallation, AgentProfile, Pod and AgentRegistry are untouched', async () => {
    const before = await snapshot();
    await sweepRegistryDrift({ dryRun: false });
    expect(await snapshot()).toEqual(before);
  });

  test('a dry run counts but writes nothing', async () => {
    const before = await Installable.collection.find({}).toArray();
    const result = await sweepRegistryDrift({ dryRun: true });
    expect(result).toMatchObject({ scanned: 5, inserted: 4, existing: 1, dryRun: true });
    expect(await Installable.collection.find({}).toArray()).toEqual(before);
  });

  test('browse never lists a backfilled row, and an unverified or ephemeral one is unpublished', async () => {
    await sweepRegistryDrift({ dryRun: false });
    const app = express();
    app.use(express.json());
    app.use('/api/marketplace', require('../../routes/marketplace-api'));
    const res = await request(app).get('/api/marketplace/browse?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i) => i.installableId).sort();
    // Backfilled rows are never listings, verified or not.
    expect(ids).toEqual(['@alice/listed']);
    const smoke = await Installable.findOne({ installableId: 'smoke-seat' }).lean();
    const byo = await Installable.findOne({ installableId: 'byo-x' }).lean();
    expect(smoke.marketplace.published).toBe(false);
    expect(byo).toMatchObject({ source: 'user', marketplace: { published: false } });
  });

  // A January seed left a registry row whose agentName is null; String(null)
  // turned it into an Installable keyed "null". A row with no usable name is skipped.
  test('a registry row with no agentName is skipped, never keyed "null"', async () => {
    const nameless = { registry: 'commonly-official', status: 'active', latestVersion: '1.0.0' };
    await AgentRegistry.collection.insertMany([
      // The unique agentName index admits one null-or-missing row at most.
      { agentName: null, displayName: 'Nameless', ...nameless },
      { agentName: '   ', displayName: 'Blank', ...nameless },
    ]);
    const dry = await sweepRegistryDrift({ dryRun: true });
    expect(dry).toMatchObject({ scanned: 7, inserted: 4, existing: 1, skipped: 2, errors: 0 });

    const result = await sweepRegistryDrift({ dryRun: false });
    expect(result).toMatchObject({ scanned: 7, inserted: 4, existing: 1, skipped: 2, errors: 0 });
    expect(await Installable.countDocuments({ installableId: { $in: ['null', 'undefined', '', '   '] } })).toBe(0);
    expect(await Installable.countDocuments()).toBe(5);
  });

  test('the write-path mirror skips a nameless row too', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await mirrorRegistryRow({ agentName: null, displayName: 'Nameless', registry: 'commonly-official' }, 'test');
    await mirrorRegistryRow({ agentName: '  ', displayName: 'Blank', registry: 'commonly-official' }, 'test');
    warn.mockRestore();
    expect(await Installable.countDocuments({ installableId: { $in: ['null', '', '  '] } })).toBe(0);
  });

  test('a duplicate-key race on insert counts as existing', async () => {
    const spy = jest.spyOn(Installable, 'updateOne').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
    );
    try {
      const result = await sweepRegistryDrift({ dryRun: false });
      expect(result.errors).toBe(0);
      expect(result.inserted + result.existing).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });
});
