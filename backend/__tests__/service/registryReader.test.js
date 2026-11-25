/**
 * The agent-catalog read path (ADR-001 Phase 3 PR B) against real Mongo:
 * off reads nothing new, shadow only counts, on serves display fields from
 * Installable and everything else from AgentRegistry.
 */
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const Installable = require('../../models/Installable');
const { AgentRegistry } = require('../../models/AgentRegistry');
const { sweepRegistryDrift } = require('../../services/installable/registryReconciler');
const {
  readRegistryDisplay, readRegistryDisplayOne, readPathMode, readPathCounters,
  resetReadPathCounters, formatReadPathCounters,
} = require('../../services/installable/registryReader');

jest.setTimeout(60000);

const ownerId = new mongoose.Types.ObjectId();

const row = (agentName, extra = {}) => ({
  agentName,
  displayName: `${agentName} display`,
  description: `${agentName} does things.`,
  manifest: {
    name: agentName,
    version: '1.2.0',
    context: { required: ['context:read'], optional: ['memory:read'] },
    runtime: { type: 'standalone', connection: 'rest', runtimeType: 'wrapper' },
    configSchema: { defaultInstructions: 'Private prompt.' },
    capabilities: [{ name: 'cap', description: 'A capability' }],
  },
  latestVersion: '1.2.0',
  registry: 'commonly-community',
  verified: true,
  categories: ['productivity', 'dev'],
  tags: ['dev', 'helper'],
  iconUrl: `bottts:${agentName}`,
  publisher: { userId: ownerId, name: 'alice' },
  ...extra,
});

const lean = (agentName) => AgentRegistry.findOne({ agentName }).lean();

describe('registryReader', () => {
  const saved = process.env.INSTALLABLE_READ_PATH;
  let warn;

  beforeAll(async () => {
    await setupMongoDb();
    await Installable.init();
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.INSTALLABLE_READ_PATH;
    else process.env.INSTALLABLE_READ_PATH = saved;
    await closeMongoDb();
  });
  beforeEach(async () => {
    await clearMongoDb();
    resetReadPathCounters();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AgentRegistry.create([row('alpha'), row('beta'), row('gamma')]);
    await sweepRegistryDrift({ dryRun: false });
  });
  afterEach(() => jest.restoreAllMocks());

  const setMode = (mode) => {
    if (mode === undefined) delete process.env.INSTALLABLE_READ_PATH;
    else process.env.INSTALLABLE_READ_PATH = mode;
  };

  test('unset or unknown is off, read on every call', () => {
    setMode(undefined);
    expect(readPathMode()).toBe('off');
    setMode('ON ');
    expect(readPathMode()).toBe('on');
    setMode('yes');
    expect(readPathMode()).toBe('off');
    setMode('shadow');
    expect(readPathMode()).toBe('shadow');
  });

  test('off returns the same rows and never queries Installable', async () => {
    setMode(undefined);
    const find = jest.spyOn(Installable, 'find');
    const rows = [await lean('alpha')];
    expect(await readRegistryDisplay(rows, 't')).toBe(rows);
    expect(await readRegistryDisplayOne(rows[0], 't')).toBe(rows[0]);
    expect(find).not.toHaveBeenCalled();
    expect(readPathCounters().reads).toBe(0);
    expect(formatReadPathCounters()).toBe('');
  });

  test('on, in sync: the rows come back unchanged', async () => {
    setMode('on');
    const rows = [await lean('alpha'), await lean('beta')];
    const out = await readRegistryDisplay(rows, 't');
    expect(out).toEqual(rows);
    expect(readPathCounters()).toMatchObject({ reads: 1, rows: 2, mismatchedRows: 0, missing: 0, served: 0 });
  });

  test('on: drifted display fields come from Installable; the hybrid fields stay on AgentRegistry', async () => {
    await Installable.updateOne({ installableId: 'alpha' }, {
      $set: {
        name: 'Alpha Renamed',
        description: 'New description.',
        version: '2.0.0',
        status: 'deprecated',
        requires: ['context:read', 'messages:write'],
        'marketplace.verified': false,
        'marketplace.tags': ['fresh'],
        'components.0.persona.avatar': 'bottts:new',
        'components.0.metadata.registryRow.categories': ['research'],
        'components.0.metadata.registryManifest.contextOptional': ['other:scope'],
        'components.0.metadata.registryManifest.runtimeType': 'webhook',
      },
    });
    setMode('on');
    const ar = await lean('alpha');
    const [out] = await readRegistryDisplay([ar], 't');
    expect(out).toMatchObject({
      displayName: 'Alpha Renamed',
      description: 'New description.',
      latestVersion: '2.0.0',
      status: 'deprecated',
      verified: false,
      tags: ['fresh'],
      iconUrl: 'bottts:new',
      categories: ['research'],
    });
    expect(out.manifest.context.required).toEqual(['context:read', 'messages:write']);
    // Never from Installable: these do not round-trip, or belong to the owner.
    expect(out.manifest.context.optional).toEqual(['memory:read']);
    expect(out.manifest.configSchema).toEqual({ defaultInstructions: 'Private prompt.' });
    expect(out.manifest.runtime.runtimeType).toBe('wrapper');
    expect(out.manifest.capabilities).toEqual(ar.manifest.capabilities);
    expect(out.publisher).toEqual(ar.publisher);
    expect(out.registry).toBe('commonly-community');
    expect(out._id).toEqual(ar._id);
    // The input row is not mutated.
    expect(ar.displayName).toBe('alpha display');
    expect(readPathCounters()).toMatchObject({ mismatchedRows: 1, served: 1 });
    expect(readPathCounters().fields.displayName).toBe(1);
  });

  test('on: a marketplace-written avatar never replaces the registry icon', async () => {
    await Installable.updateOne({ installableId: 'beta' }, {
      $set: { 'components.0.persona.avatar': 'https://evil.example/x.png', name: 'Beta Listing' },
      $unset: { origin: 1 },
    });
    setMode('on');
    const [out] = await readRegistryDisplay([await lean('beta')], 't');
    expect(out.iconUrl).toBe('bottts:beta');
    expect(out.displayName).toBe('Beta Listing');
  });

  test('on: a missing Installable falls back to AgentRegistry and is counted', async () => {
    await Installable.deleteOne({ installableId: 'gamma' });
    setMode('on');
    const rows = [await lean('gamma')];
    const out = await readRegistryDisplay(rows, 't');
    expect(out[0]).toBe(rows[0]);
    expect(readPathCounters()).toMatchObject({ missing: 1, fallbacks: 1 });
  });

  test('on: a non-agent Installable under the same key is treated as missing', async () => {
    await Installable.deleteOne({ installableId: 'gamma' });
    await Installable.collection.insertOne({
      installableId: 'gamma',
      name: 'A tool',
      kind: 'app',
      version: '1.0.0',
      components: [{ name: 't', type: 'slash-command' }],
    });
    setMode('on');
    const rows = [await lean('gamma')];
    expect((await readRegistryDisplay(rows, 't'))[0]).toBe(rows[0]);
    expect(readPathCounters().fallbacks).toBe(1);
  });

  test('shadow counts a planted mismatch, logs it once, and returns the registry rows untouched', async () => {
    await Installable.updateOne({ installableId: 'alpha' }, { $set: { name: 'Drifted' } });
    setMode('shadow');
    const rows = [await lean('alpha'), await lean('beta')];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const out = await readRegistryDisplay(rows, 'catalog.list');
    expect(out).toBe(rows);
    expect(JSON.parse(JSON.stringify(out))).toEqual(snapshot);
    expect(readPathCounters()).toMatchObject({ mode: 'shadow', reads: 1, mismatchedRows: 1, served: 0 });
    expect(readPathCounters().fields).toEqual({ displayName: 1 });
    const lines = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('mismatch site='));
    expect(lines).toEqual(['[installable-read-path] mismatch site=catalog.list agent=alpha fields=displayName']);
    expect(formatReadPathCounters()).toContain('readPath=shadow');
    expect(formatReadPathCounters()).toContain('fields=displayName:1');
  });

  test('shadow log lines are rate-limited on a hot path', async () => {
    await Installable.updateOne({ installableId: 'alpha' }, { $set: { name: 'Drifted' } });
    setMode('shadow');
    const rows = [await lean('alpha')];
    for (let i = 0; i < 25; i += 1) await readRegistryDisplay(rows, 'hot');
    const lines = warn.mock.calls.filter(([m]) => String(m).includes('mismatch site=hot'));
    expect(lines).toHaveLength(10);
    expect(readPathCounters().mismatchedRows).toBe(25);
  });

  test('shadow and on survive a thrown Installable query', async () => {
    jest.spyOn(Installable, 'find').mockImplementation(() => { throw new Error('boom'); });
    const rows = [await lean('alpha')];
    setMode('shadow');
    expect(await readRegistryDisplay(rows, 't')).toBe(rows);
    setMode('on');
    expect(await readRegistryDisplay(rows, 't')).toBe(rows);
    expect(readPathCounters()).toMatchObject({ errors: 2, fallbacks: 1 });
  });

  test('a rejected Installable query is survived too', async () => {
    jest.spyOn(Installable, 'find').mockReturnValue({
      select: () => ({ lean: () => Promise.reject(new Error('timeout')) }),
    });
    setMode('shadow');
    const rows = [await lean('alpha')];
    expect(await readRegistryDisplay(rows, 't')).toBe(rows);
    expect(readPathCounters().errors).toBe(1);
  });

  test('a nameless row is never keyed or looked up', async () => {
    setMode('on');
    const find = jest.spyOn(Installable, 'find');
    const nameless = { agentName: null, displayName: 'Nameless' };
    const blank = { agentName: '  ', displayName: 'Blank' };
    const out = await readRegistryDisplay([nameless, blank], 't');
    expect(out[0]).toBe(nameless);
    expect(out[1]).toBe(blank);
    expect(find).not.toHaveBeenCalled();
    expect(readPathCounters()).toMatchObject({ nameless: 2, missing: 0 });
  });

  test('a batch read issues one Installable query', async () => {
    setMode('on');
    const find = jest.spyOn(Installable, 'find');
    const rows = await AgentRegistry.find({}).lean();
    await readRegistryDisplay(rows, 't');
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({ installableId: { $in: ['alpha', 'beta', 'gamma'] } });
  });

  test('`fields` narrows the comparison to what the site projected', async () => {
    await Installable.updateOne({ installableId: 'alpha' }, { $set: { name: 'Drifted' } });
    setMode('on');
    const projected = await AgentRegistry.findOne({ agentName: 'alpha' }).select('agentName iconUrl').lean();
    const [out] = await readRegistryDisplay([projected], 't', ['iconUrl']);
    expect(out).toBe(projected);
    expect(readPathCounters().mismatchedRows).toBe(0);
  });

  test('a mongoose document comes back as a plain object only when something was overlaid', async () => {
    setMode('on');
    const doc = await AgentRegistry.getByName('alpha');
    expect(await readRegistryDisplayOne(doc, 't')).toBe(doc);
    await Installable.updateOne({ installableId: 'alpha' }, { $set: { description: 'Changed.' } });
    const out = await readRegistryDisplayOne(doc, 't');
    expect(out.description).toBe('Changed.');
    expect(out.versions).toHaveLength(doc.versions.length);
  });

  test('the reader writes nothing', async () => {
    await Installable.updateOne({ installableId: 'alpha' }, { $set: { name: 'Drifted' } });
    const read = (m) => m.collection.find({}).sort({ _id: 1 }).toArray();
    const before = { i: await read(Installable), r: await read(AgentRegistry) };
    for (const mode of ['shadow', 'on']) {
      setMode(mode);
      await readRegistryDisplay(await AgentRegistry.find({}).lean(), 't');
    }
    expect({ i: await read(Installable), r: await read(AgentRegistry) }).toEqual(before);
  });
});
