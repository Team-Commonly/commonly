/**
 * Backfilled Installables follow AgentRegistry edits (ADR-001 Phase 3). An
 * edit to an existing registry row refreshes the display fields of the
 * Installable the bridge created, and only that one: a marketplace listing or
 * a native-seeded builtin under the same id is never written, and no identity
 * table is read or written.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const Installable = require('../../models/Installable');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const AgentBootstrapService = require('../../services/agentBootstrapService').default
  || require('../../services/agentBootstrapService');
const {
  sweepRegistryDrift, refreshBridgeRow,
} = require('../../services/installable/registryReconciler');
const {
  readRegistryDisplayOne, readPathCounters, resetReadPathCounters,
} = require('../../services/installable/registryReader');

const JWT_SECRET = 'test-jwt-secret-bridge-refresh';

jest.setTimeout(60000);

const manifest = (name, extra = {}) => ({
  name,
  version: '1.0.0',
  description: `${name} manifest`,
  context: { required: ['context:read'] },
  runtime: { type: 'standalone', connection: 'rest' },
  ...extra,
});

const registryRow = (agentName, publisherId, extra = {}) => ({
  agentName,
  displayName: `${agentName} display`,
  description: `${agentName} does things.`,
  manifest: manifest(agentName),
  latestVersion: '1.0.0',
  registry: 'commonly-community',
  verified: true,
  categories: ['productivity'],
  tags: ['helper'],
  iconUrl: `bottts:${agentName}`,
  publisher: { userId: publisherId, name: 'alice' },
  ...extra,
});

const MARKED = 'alpha';
const LISTING = 'listed';
const NATIVE = 'native-app';

const raw = (installableId) => Installable.collection.findOne({ installableId });
const unmarked = async () => ({ listing: await raw(LISTING), native: await raw(NATIVE) });

describe('refreshBridgeRow and the sweep refresh', () => {
  let app;
  let alice;
  let token;
  let pristine;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    await Installable.init();
    app = express();
    app.use(express.json());
    app.use('/api/registry', require('../../routes/registry'));
  });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    alice = await User.create({ username: 'dev-alice', email: 'alice@test.com', password: 'password123' });
    token = jwt.sign({ id: alice._id }, JWT_SECRET);
    await AgentRegistry.create([
      registryRow(MARKED, alice._id),
      registryRow(LISTING, alice._id),
      registryRow(NATIVE, alice._id, { registry: 'commonly-official' }),
    ]);
    // A marketplace listing and a native-seeded builtin own their rows; the
    // sweep sees them as existing and must never shape them.
    await Installable.create({
      installableId: LISTING,
      name: 'Listing Name',
      description: 'The marketplace copy.',
      version: '3.0.0',
      kind: 'agent',
      source: 'marketplace',
      scope: 'pod',
      components: [{ name: LISTING, type: 'agent', runtime: 'webhook', persona: { avatar: 'bottts:own' } }],
      marketplace: { published: true, category: 'dev', tags: ['x'] },
      publisher: { userId: alice._id, name: 'alice' },
      status: 'active',
    });
    await Installable.create({
      installableId: NATIVE,
      name: 'Native Name',
      description: 'Seeded natively.',
      version: '0.1.0',
      kind: 'app',
      source: 'builtin',
      scope: 'instance',
      components: [{ name: NATIVE, type: 'agent', runtime: 'native', persona: { displayName: 'Native Name' } }],
      status: 'active',
    });
    pristine = await unmarked();
    await sweepRegistryDrift({ dryRun: false });
  });
  afterEach(() => jest.restoreAllMocks());

  const patchEntry = (name, body) => request(app)
    .patch(`/api/registry/agents/${encodeURIComponent(name)}/owned-entry`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  const publish = (name, extra = {}) => request(app)
    .post('/api/registry/publish')
    .set('Authorization', `Bearer ${token}`)
    .send({
      manifest: manifest(name, {
        version: '2.0.0',
        description: 'A new description.',
        displayName: `${name} v2`,
        categories: ['research', 'writing'],
        tags: ['fresh'],
        ...extra,
      }),
    });

  const shadowDrift = async (agentName) => {
    const saved = process.env.INSTALLABLE_READ_PATH;
    process.env.INSTALLABLE_READ_PATH = 'shadow';
    resetReadPathCounters();
    try {
      await readRegistryDisplayOne(await AgentRegistry.findOne({ agentName }).lean(), 'test');
      return readPathCounters().mismatchedRows;
    } finally {
      if (saved === undefined) delete process.env.INSTALLABLE_READ_PATH;
      else process.env.INSTALLABLE_READ_PATH = saved;
    }
  };

  test('the backfill marked only the row it created, and left the others byte-identical', async () => {
    expect((await raw(MARKED)).origin).toBe('registry-backfill');
    // Both differ from what the bridge would write, so only the mark keeps the sweep off them.
    expect(await unmarked()).toEqual(pristine);
    expect(pristine.listing.origin).toBeUndefined();
    expect(pristine.native.origin).toBeUndefined();
  });

  test('an owned-entry rename updates the marked name and moves updatedAt; unmarked rows are untouched', async () => {
    const before = await raw(MARKED);
    const others = await unmarked();
    await new Promise((r) => { setTimeout(r, 5); });

    for (const name of [MARKED, LISTING, NATIVE]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patchEntry(name, { displayName: `Renamed ${name}` });
      expect(res.status).toBe(200);
    }

    const after = await raw(MARKED);
    expect(after.name).toBe(`Renamed ${MARKED}`);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after).toMatchObject({ origin: 'registry-backfill', source: before.source, status: before.status });
    expect(after.marketplace.published).toBe(before.marketplace.published);
    expect(await unmarked()).toEqual(others);
  });

  test('after a rename, shadow reads count zero drift for the row', async () => {
    await patchEntry(MARKED, { displayName: 'Renamed Alpha' }).expect(200);
    expect(await shadowDrift(MARKED)).toBe(0);
  });

  // Retire and restore change only status, which the refresh never copies. The
  // marked name is made stale first, so each passes only if that call refreshes.
  test('a retire refreshes stale display fields, keeps the row status, and writes no unmarked row', async () => {
    const before = await raw(MARKED);
    const others = await unmarked();
    await Installable.collection.updateOne({ installableId: MARKED }, { $set: { name: 'Stale before retire' } });
    for (const name of [MARKED, LISTING, NATIVE]) {
      // eslint-disable-next-line no-await-in-loop
      await patchEntry(name, { retired: true }).expect(200);
    }
    const after = await raw(MARKED);
    expect(after.name).toBe(before.name);
    // Status is a gate the reader takes from AgentRegistry; the row keeps its own.
    expect(after.status).toBe('active');
    expect(await shadowDrift(MARKED)).toBe(0);
    expect(await unmarked()).toEqual(others);
  });

  test('a restore refreshes stale display fields and keeps the row status', async () => {
    const before = await raw(MARKED);
    await patchEntry(MARKED, { retired: true }).expect(200);
    await Installable.collection.updateOne({ installableId: MARKED }, { $set: { name: 'Stale before restore' } });
    await patchEntry(MARKED, { retired: false }).expect(200);
    const after = await raw(MARKED);
    expect(after.name).toBe(before.name);
    expect(after.status).toBe('active');
    expect(await shadowDrift(MARKED)).toBe(0);
  });

  test('a registry re-publish refreshes version, description and taxonomy on the marked row only', async () => {
    const others = await unmarked();
    await publish(MARKED).expect(200);
    await publish(LISTING).expect(200);
    await publish(NATIVE).expect(200);

    const after = await raw(MARKED);
    expect(after).toMatchObject({
      name: `${MARKED} v2`,
      description: 'A new description.',
      version: '2.0.0',
      marketplace: { category: 'research', tags: ['writing', 'fresh'] },
    });
    expect(after.components[0].metadata.registryRow.categories).toEqual(['research', 'writing']);
    expect(await shadowDrift(MARKED)).toBe(0);
    expect(await unmarked()).toEqual(others);
  });

  test('POST /seed refreshes a marked row the seed updates', async () => {
    await AgentRegistry.create(registryRow('commonly-bot', alice._id, { displayName: 'Old Bot' }));
    await sweepRegistryDrift({ dryRun: false });
    await request(app).post('/api/registry/seed').set('Authorization', `Bearer ${token}`).expect(200);
    expect((await raw('commonly-bot')).name).not.toBe('Old Bot');
    expect(await shadowDrift('commonly-bot')).toBe(0);
  });

  test('agent bootstrap refreshes a marked row it updates', async () => {
    jest.spyOn(AgentBootstrapService, 'loadManifests').mockReturnValue([{
      agentName: MARKED,
      displayName: 'Booted Alpha',
      description: 'From the manifest.',
      manifest: manifest(MARKED, { version: '4.0.0' }),
      version: '4.0.0',
      categories: ['ops'],
      tags: ['boot'],
    }]);
    await AgentBootstrapService.bootstrap();
    expect(await raw(MARKED)).toMatchObject({
      name: 'Booted Alpha', version: '4.0.0', marketplace: { category: 'ops' },
    });
    expect(await shadowDrift(MARKED)).toBe(0);
  });

  test('the native seed refreshes a marked row under a first-party id', async () => {
    // eslint-disable-next-line global-require
    const { seedNativeAgents } = require('../../scripts/seed-native-agents');
    await Pod.create({
      _id: new mongoose.Types.ObjectId('69dade8019b75dc81f51f318'),
      name: 'Demo',
      type: 'chat',
      createdBy: alice._id,
      members: [alice._id],
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AgentRegistry.create(registryRow('task-clerk', alice._id, {
      registry: 'commonly-official',
      categories: ['stale'],
      manifest: manifest('task-clerk', { context: { required: [] } }),
    }));
    await sweepRegistryDrift({ dryRun: false });
    expect((await raw('task-clerk')).origin).toBe('registry-backfill');
    await seedNativeAgents();
    expect(await shadowDrift('task-clerk')).toBe(0);
  });

  test('the sweep refreshes a drifted marked row once; a second pass writes nothing', async () => {
    await Installable.collection.updateOne(
      { installableId: MARKED },
      { $set: { name: 'Stale', requires: [], 'components.0.persona.avatar': 'bottts:stale' } },
    );
    const others = await unmarked();

    const first = await sweepRegistryDrift({ dryRun: false });
    expect(first).toMatchObject({ scanned: 3, inserted: 0, existing: 3, refreshed: 1, errors: 0 });
    const fixed = await raw(MARKED);
    expect(fixed.name).toBe(`${MARKED} display`);
    expect(fixed.requires).toEqual(['context:read']);
    expect(fixed.components[0].persona.avatar).toBe(`bottts:${MARKED}`);
    expect(await shadowDrift(MARKED)).toBe(0);

    const before = await Installable.collection.find({}).sort({ _id: 1 }).toArray();
    const second = await sweepRegistryDrift({ dryRun: false });
    expect(second).toMatchObject({ refreshed: 0, existing: 3 });
    expect(await Installable.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await unmarked()).toEqual(others);
  });

  test('a dry-run sweep counts the refresh but writes nothing', async () => {
    await Installable.collection.updateOne({ installableId: MARKED }, { $set: { name: 'Stale' } });
    const before = await Installable.collection.find({}).sort({ _id: 1 }).toArray();
    const result = await sweepRegistryDrift({ dryRun: true });
    expect(result.refreshed).toBe(1);
    expect(await Installable.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  test('a cleared registry icon blanks the avatar and never $unsets it', async () => {
    await AgentRegistry.updateOne({ agentName: MARKED }, { $set: { iconUrl: '' } });
    expect(await refreshBridgeRow(await AgentRegistry.findOne({ agentName: MARKED }).lean(), 'test')).toBe(true);
    const after = await raw(MARKED);
    expect(after.components[0].persona).toHaveProperty('avatar', '');
  });

  test('no identity table changes across every path', async () => {
    const podId = new mongoose.Types.ObjectId();
    await Pod.collection.insertOne({ _id: podId, name: 'P', type: 'chat', members: [alice._id] });
    const identity = { agentName: MARKED, podId, instanceId: 'default' };
    await AgentInstallation.collection.insertOne({ ...identity, status: 'active' });
    await AgentProfile.collection.insertOne({ ...identity, purpose: 'p' });
    await User.collection.insertOne({ username: 'alpha-bot', isBot: true, botMetadata: { agentName: MARKED } });
    const snapshot = async () => {
      const read = (model) => model.collection.find({}).sort({ _id: 1 }).toArray();
      // auth stamps the caller's lastActive on every request; that is not this change.
      const users = (await read(User)).map(({ lastActive, ...u }) => u);
      return {
        users, pods: await read(Pod), installations: await read(AgentInstallation), profiles: await read(AgentProfile),
      };
    };
    const before = await snapshot();
    await patchEntry(MARKED, { displayName: 'Renamed' }).expect(200);
    await publish(MARKED).expect(200);
    await Installable.collection.updateOne({ installableId: MARKED }, { $set: { name: 'Stale' } });
    await sweepRegistryDrift({ dryRun: false });
    expect(await snapshot()).toEqual(before);
  });

  test('a refresh failure does not fail the request', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Installable, 'findOne').mockImplementation(() => { throw new Error('installable down'); });
    const res = await patchEntry(MARKED, { displayName: 'Renamed Anyway' });
    expect(res.status).toBe(200);
    expect((await AgentRegistry.findOne({ agentName: MARKED }).lean()).displayName).toBe('Renamed Anyway');
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('[installable-mirror] refresh'))).toBe(true);
  });
});
