/**
 * ADR-001 Phase 3 PR B: the switched agent-catalog routes under
 * INSTALLABLE_READ_PATH. After a real sweep, `on` answers exactly what `off`
 * answers; `off` never queries Installable; the catalog gates stay on
 * AgentRegistry in every mode; install never reads Installable.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Installable = require('../../models/Installable');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const { sweepRegistryDrift } = require('../../services/installable/registryReconciler');
const { readPathCounters, resetReadPathCounters } = require('../../services/installable/registryReader');

const SECRET = 'registry-read-path-test';
jest.setTimeout(90000);

const manifest = (name) => ({
  name,
  version: '1.0.0',
  capabilities: [{ name: 'chat', description: 'Talks' }],
  context: { required: ['context:read'], optional: [] },
  runtime: { type: 'standalone', connection: 'rest' },
  configSchema: { defaultInstructions: `Private prompt for ${name}.` },
});

const registryRow = (agentName, extra = {}) => ({
  agentName,
  displayName: `${agentName} display`,
  description: `${agentName} helps.`,
  manifest: manifest(agentName),
  latestVersion: '1.0.0',
  versions: [{ version: '1.0.0', manifest: manifest(agentName), publishedAt: new Date('2026-10-01T00:00:00Z') }],
  registry: 'commonly-community',
  verified: true,
  categories: ['productivity', 'dev'],
  tags: ['dev', 'helper'],
  stats: { installs: 3 },
  iconUrl: `bottts:${agentName}`,
  ...extra,
});

describe('agent-catalog routes under INSTALLABLE_READ_PATH', () => {
  const saved = process.env.INSTALLABLE_READ_PATH;
  let app; let user; let auth; let pod; let installPod;

  const setMode = (mode) => {
    if (mode === undefined) delete process.env.INSTALLABLE_READ_PATH;
    else process.env.INSTALLABLE_READ_PATH = mode;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    await Installable.init();
    app = express();
    app.use(express.json());
    app.use('/api/registry', require('../../routes/registry'));

    user = await User.create({
      username: 'read-path-user', email: 'read-path@test.com', password: 'password123',
      entitlements: { cloudAgents: true },
    });
    auth = `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;
    pod = await Pod.create({ name: 'Read path', type: 'chat', createdBy: user._id, members: [user._id] });
    installPod = await Pod.create({ name: 'Install target', type: 'chat', createdBy: user._id, members: [user._id] });

    await AgentRegistry.create([
      registryRow('alpha'),
      registryRow('beta', { categories: ['research'], tags: [] }),
      registryRow('no-installable'),
      registryRow('smoke-seat', { verified: false }),
      registryRow('byo-x', { registry: 'private', ephemeral: true, publisher: { userId: user._id, name: 'u' } }),
      registryRow('codex', { displayName: 'Codex', registry: 'private' }),
    ]);
    // A legacy row with an empty description: the bridge falls back to the
    // display name, which must not read as drift.
    await AgentRegistry.collection.updateOne({ agentName: 'beta' }, { $set: { description: '' } });
    await sweepRegistryDrift({ dryRun: false });
    // A registry row the sweep has not reached yet.
    await Installable.deleteOne({ installableId: 'no-installable' });

    // A seat with its own label, which no read-path mode may change.
    await AgentInstallation.create({
      agentName: 'alpha', instanceId: 'default', podId: pod._id, version: '1.0.0',
      installedBy: user._id, displayName: 'My Alpha', status: 'active',
    });
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.INSTALLABLE_READ_PATH;
    else process.env.INSTALLABLE_READ_PATH = saved;
    await closeMongoDb();
  });

  beforeEach(() => {
    resetReadPathCounters();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (path) => request(app).get(path).set('Authorization', auth);
  const READS = () => [
    '/api/registry/agents?limit=50',
    '/api/registry/agents/alpha',
    '/api/registry/agents/beta',
    '/api/registry/agents/no-installable',
    `/api/registry/pods/${pod._id}/agents`,
    `/api/registry/pods/${pod._id}/agents/alpha`,
  ];

  const readAll = async () => {
    const out = {};
    for (const path of READS()) {
      const res = await get(path);
      expect(res.status).toBe(200);
      out[path] = res.body;
    }
    return out;
  };

  test('off never queries Installable on the switched routes', async () => {
    setMode(undefined);
    const find = jest.spyOn(Installable, 'find');
    const findOne = jest.spyOn(Installable, 'findOne');
    await readAll();
    expect(find).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(readPathCounters().reads).toBe(0);
  });

  test('after the sweep, on and shadow answer byte-for-byte what off answers', async () => {
    setMode(undefined);
    const off = await readAll();
    setMode('on');
    const on = await readAll();
    setMode('shadow');
    const shadow = await readAll();
    expect(on).toEqual(off);
    expect(shadow).toEqual(off);
    // Nothing drifted, and the one row with no Installable fell back.
    expect(readPathCounters()).toMatchObject({ mismatchedRows: 0, served: 0, errors: 0 });
    expect(readPathCounters().missing).toBeGreaterThan(0);
  });

  test('the catalog verified and ephemeral gates hold in every mode', async () => {
    for (const mode of [undefined, 'shadow', 'on']) {
      setMode(mode);
      const res = await get('/api/registry/agents?limit=50&verified=false');
      const names = res.body.agents.map((a) => a.name).sort();
      expect(names).toEqual(['alpha', 'beta', 'codex', 'no-installable']);
    }
  });

  test('a batch catalog read issues one Installable query', async () => {
    setMode('on');
    const find = jest.spyOn(Installable, 'find');
    await get('/api/registry/agents?limit=50');
    expect(find).toHaveBeenCalledTimes(1);
  });

  describe('with a drifted Installable', () => {
    beforeAll(async () => {
      await Installable.updateOne({ installableId: 'alpha' }, {
        $set: { name: 'Alpha Renamed', 'components.0.persona.avatar': 'bottts:renamed' },
      });
    });
    afterAll(async () => {
      await Installable.updateOne({ installableId: 'alpha' }, {
        $set: { name: 'alpha display', 'components.0.persona.avatar': 'bottts:alpha' },
      });
    });

    test('shadow leaves every response unchanged and counts the drift', async () => {
      setMode(undefined);
      const off = await readAll();
      setMode('shadow');
      expect(await readAll()).toEqual(off);
      expect(readPathCounters().mismatchedRows).toBeGreaterThan(0);
      expect(readPathCounters().fields.displayName).toBeGreaterThan(0);
    });

    test('on serves the drifted display fields; manifest internals stay on AgentRegistry', async () => {
      setMode('on');
      const list = await get('/api/registry/agents?limit=50');
      expect(list.body.agents.find((a) => a.name === 'alpha')).toMatchObject({
        displayName: 'Alpha Renamed', iconUrl: 'bottts:renamed',
      });
      const detail = await get('/api/registry/agents/alpha');
      expect(detail.body.displayName).toBe('Alpha Renamed');
      expect(detail.body.manifest.configSchema).toEqual({ defaultInstructions: 'Private prompt for alpha.' });
    });

    test('a retired registry row stays retired in catalog detail under on', async () => {
      await AgentRegistry.updateOne({ agentName: 'alpha' }, { $set: { status: 'unpublished' } });
      try {
        setMode('on');
        const detail = await get('/api/registry/agents/alpha');
        expect(detail.body.status).toBe('unpublished');
        expect(detail.body.verified).toBe(true);
        expect(detail.body.displayName).toBe('Alpha Renamed');
      } finally {
        await AgentRegistry.updateOne({ agentName: 'alpha' }, { $set: { status: 'active' } });
      }
    });

    test("on keeps the seat's own displayName in pod-agents and takes only the icon", async () => {
      setMode('on');
      const roster = await get(`/api/registry/pods/${pod._id}/agents`);
      const seat = roster.body.agents.find((a) => a.name === 'alpha');
      expect(seat.displayName).toBe('My Alpha');
      expect(seat.iconUrl).toBe('bottts:renamed');
      const one = await get(`/api/registry/pods/${pod._id}/agents/alpha`);
      expect(one.body.agent.displayName).toBe('My Alpha');
      expect(one.body.agent.iconUrl).toBe('bottts:renamed');
      const row = await AgentInstallation.findOne({ agentName: 'alpha', podId: pod._id }).lean();
      expect(row.displayName).toBe('My Alpha');
    });
  });

  describe('install under on', () => {
    beforeAll(async () => {
      await Installable.updateOne({ installableId: 'codex' }, {
        $set: { name: 'Codex Drifted', description: 'Drifted description.' },
      });
    });
    beforeEach(async () => {
      await AgentInstallation.deleteMany({ agentName: 'codex' });
      await AgentProfile.deleteMany({ agentName: 'codex' });
      await User.deleteMany({ isBot: true, 'botMetadata.agentName': 'codex' });
    });

    const install = (body) => request(app).post('/api/registry/install').set('Authorization', auth).send({
      agentName: 'codex', podId: String(installPod._id), version: '1.0.0',
      scopes: ['context:read', 'messages:write'], ...body,
    });

    // Install writes AgentProfile and AgentInstallation, so it reads only
    // AgentRegistry in every mode: a stale Installable must never persist.
    test('install reads only AgentRegistry under on, even with a drifted Installable', async () => {
      setMode('on');
      const find = jest.spyOn(Installable, 'find');
      const res = await install({ instanceId: 'mine', displayName: 'My Codex' });
      expect(res.status).toBe(200);
      const row = await AgentInstallation.findOne({ agentName: 'codex', instanceId: 'mine' }).lean();
      expect(row.displayName).toBe('My Codex');
      const profile = await AgentProfile.findOne({ agentName: 'codex', instanceId: 'mine' }).lean();
      expect(profile.name).toBe('My Codex');
      expect(profile.purpose).toBe('codex helps.');
      expect(profile.instructions).toBe('Private prompt for codex.');

      const plain = await install({ instanceId: 'plain' });
      expect(plain.status).toBe(200);
      const plainRow = await AgentInstallation.findOne({ agentName: 'codex', instanceId: 'plain' }).lean();
      expect(plainRow.displayName).toBe('Codex');
      expect(find).not.toHaveBeenCalled();
    });

    test("a curated identity's name survives a reinstall into a new pod", async () => {
      setMode('on');
      await User.create({
        username: 'codex-aria', email: 'codex-aria@bot.local', password: 'bot-no-login', isBot: true,
        botMetadata: { agentName: 'codex', instanceId: 'aria', displayName: 'Aria' },
      });
      const res = await install({ instanceId: 'aria' });
      expect(res.status).toBe(200);
      const row = await AgentInstallation.findOne({ agentName: 'codex', instanceId: 'aria' }).lean();
      expect(row.displayName).toBe('Aria');
      const bot = await User.findOne({ username: 'codex-aria' }).lean();
      expect(bot.botMetadata.displayName).toBe('Aria');
    });

    test('off installs with the registry values', async () => {
      setMode(undefined);
      const find = jest.spyOn(Installable, 'find');
      const res = await install({ instanceId: 'off' });
      expect(res.status).toBe(200);
      const row = await AgentInstallation.findOne({ agentName: 'codex', instanceId: 'off' }).lean();
      expect(row.displayName).toBe('Codex');
      expect(find).not.toHaveBeenCalled();
    });
  });

  test('backfilled rows stay out of marketplace browse in every mode', async () => {
    const market = express();
    market.use(express.json());
    market.use('/api/marketplace', require('../../routes/marketplace-api'));
    for (const mode of [undefined, 'shadow', 'on']) {
      setMode(mode);
      const res = await request(market).get('/api/marketplace/browse?limit=100');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    }
  });

  test('no identity row changes on a read in any mode', async () => {
    const read = (m) => m.collection.find({}).sort({ _id: 1 }).toArray();
    const snap = async () => ({
      users: await read(User), pods: await read(Pod), inst: await read(AgentInstallation),
      reg: await read(AgentRegistry), installables: await read(Installable),
    });
    // The first read of a fresh roster may seed its profile rows; settle that first.
    setMode(undefined);
    await readAll();
    const before = await snap();
    for (const mode of [undefined, 'shadow', 'on']) {
      setMode(mode);
      await readAll();
    }
    const after = await snap();
    expect(after.users.map((u) => ({ ...u, lastActive: undefined, updatedAt: undefined })))
      .toEqual(before.users.map((u) => ({ ...u, lastActive: undefined, updatedAt: undefined })));
    expect(after.pods).toEqual(before.pods);
    expect(after.inst).toEqual(before.inst);
    expect(after.reg).toEqual(before.reg);
    expect(after.installables).toEqual(before.installables);
  });
});
