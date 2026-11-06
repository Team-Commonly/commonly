/**
 * The boot seeder keeps one runtime per agent identity. A first-party row that
 * would enter service on an identity holding a token is skipped and logged, the
 * other apps still seed, and an app already running in process keeps refreshing.
 */

const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const Installable = require('../../models/Installable');
const AgentIdentityService = require('../../services/agentIdentityService');
const { FIRST_PARTY_APPS } = require('../../config/native-agents/apps');
const { seedNativeAgents, buildInstallationConfig } = require('../../scripts/seed-native-agents');

const DEMO_POD_ID = '69dade8019b75dc81f51f318';
const CONFLICT = 'task-clerk';

jest.setTimeout(60000);

describe('seedNativeAgents and the one-runtime check', () => {
  let creator;
  let otherPod;
  let warn;
  const demoPodId = new mongoose.Types.ObjectId(DEMO_POD_ID);
  const seeded = FIRST_PARTY_APPS.filter((app) => !app.perUser).map((app) => app.agentName);
  const conflictApp = FIRST_PARTY_APPS.find((app) => app.agentName === CONFLICT);

  const demoRow = (agentName) => AgentInstallation.findOne({ agentName, podId: demoPodId, instanceId: 'default' }).lean();

  const giveToken = async (agentName) => {
    const user = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId: 'default' });
    await User.updateOne(
      { _id: user._id },
      { $push: { agentRuntimeTokens: { tokenHash: `hash-${agentName}`, label: 'test', createdAt: new Date() } } },
    );
    return user;
  };

  const tokenCount = async (user) => (await User.findById(user._id).lean())?.agentRuntimeTokens?.length;

  const row = (agentName, overrides = {}) => AgentInstallation.create({
    agentName,
    podId: otherPod._id,
    instanceId: 'default',
    version: '1.0.0',
    status: 'active',
    installedBy: creator._id,
    config: { runtime: { runtimeType: 'webhook' } },
    ...overrides,
  });

  const warned = (agentName) => warn.mock.calls.some(([line]) => String(line).includes(agentName));

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await Promise.all([
      AgentInstallation.deleteMany({}), AgentRegistry.deleteMany({}), Installable.deleteMany({}),
      Pod.deleteMany({}), User.deleteMany({}),
    ]);
    creator = await User.create({ username: 'seed-owner', email: 'seed-owner@test.com', password: 'password123' });
    await Pod.create({ _id: demoPodId, name: 'Demo', type: 'chat', createdBy: creator._id, members: [creator._id] });
    otherPod = await Pod.create({ name: 'Other', type: 'chat', createdBy: creator._id, members: [creator._id] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('seeds every first-party app when no identity holds a token', async () => {
    await seedNativeAgents();

    const rows = await Promise.all(seeded.map(demoRow));
    expect(rows.map((entry) => [entry.status, entry.config.runtime.runtimeType]))
      .toEqual(seeded.map(() => ['active', 'native']));
  });

  it('adds no in-process row to a bring-your-own identity with a first-party name that holds a token', async () => {
    const seat = await row(CONFLICT);
    const user = await giveToken(CONFLICT);

    await seedNativeAgents();

    expect(await demoRow(CONFLICT)).toBeNull();
    const kept = await AgentInstallation.findById(seat._id).lean();
    expect(kept.config.runtime.runtimeType).toBe('webhook');
    expect(await tokenCount(user)).toBe(1);
    const demoPod = await Pod.findById(demoPodId).lean();
    expect(demoPod.members.map(String)).not.toContain(String(user._id));
  });

  it('makes no write for a skipped app, so nothing has to be taken back', async () => {
    await giveToken(CONFLICT);
    const write = jest.spyOn(AgentInstallation, 'findOneAndUpdate');

    await seedNativeAgents();

    expect(write.mock.calls.some(([filter]) => filter?.agentName === CONFLICT)).toBe(false);
  });

  it('logs the skip and seeds the other apps', async () => {
    await row(CONFLICT);
    await giveToken(CONFLICT);

    await seedNativeAgents();

    expect(warned(CONFLICT)).toBe(true);
    const others = seeded.filter((name) => name !== CONFLICT);
    expect(others.length).toBeGreaterThan(0);
    const rows = await Promise.all(others.map(demoRow));
    expect(rows.every((entry) => entry?.status === 'active')).toBe(true);
  });

  it('leaves the registry row published for a skipped app', async () => {
    await giveToken(CONFLICT);

    await seedNativeAgents();

    expect(await AgentRegistry.findOne({ agentName: CONFLICT }).lean()).not.toBeNull();
  });

  it('does not rewrite a bring-your-own row of that identity in the demo pod', async () => {
    const seat = await row(CONFLICT, { podId: demoPodId });
    await giveToken(CONFLICT);

    await seedNativeAgents();

    const kept = await AgentInstallation.findById(seat._id).lean();
    expect(kept.config.runtime.runtimeType).toBe('webhook');
  });

  it.each(['paused', 'stale', 'uninstalled'])('leaves a %s in-process row where it is, token and all', async (status) => {
    const seat = await row(CONFLICT, { podId: demoPodId, status, config: { runtime: { runtimeType: 'native' } } });
    const user = await giveToken(CONFLICT);

    await seedNativeAgents();

    expect((await AgentInstallation.findById(seat._id).lean()).status).toBe(status);
    expect(await tokenCount(user)).toBe(1);
    expect(warned(CONFLICT)).toBe(true);
  });

  it('keeps refreshing an app already active in process, whatever its identity holds', async () => {
    const seat = await row(CONFLICT, {
      podId: demoPodId, config: { runtime: { runtimeType: 'native' }, systemPrompt: 'last deploy' },
    });
    await giveToken(CONFLICT);

    await seedNativeAgents();

    const refreshed = await AgentInstallation.findById(seat._id).lean();
    expect(refreshed.config.systemPrompt).toBe(buildInstallationConfig(conflictApp).systemPrompt);
    expect(warned(CONFLICT)).toBe(false);
  });

  describe('a token that arrives during the write', () => {
    const tokenArrivesDuringWrite = () => {
      const real = AgentInstallation.findOneAndUpdate.bind(AgentInstallation);
      jest.spyOn(AgentInstallation, 'findOneAndUpdate').mockImplementation(async (filter, ...rest) => {
        const written = await real(filter, ...rest);
        if (filter?.agentName === CONFLICT) await giveToken(CONFLICT);
        return written;
      });
    };

    it('takes a new row back', async () => {
      tokenArrivesDuringWrite();

      await seedNativeAgents();

      expect(await demoRow(CONFLICT)).toBeNull();
      expect(warned(CONFLICT)).toBe(true);
    });

    it('puts an existing row back as it was', async () => {
      const seat = await row(CONFLICT, { podId: demoPodId, status: 'paused' });
      tokenArrivesDuringWrite();

      await seedNativeAgents();

      const kept = await AgentInstallation.findById(seat._id).lean();
      expect(kept.status).toBe('paused');
      expect(kept.config.runtime.runtimeType).toBe('webhook');
    });

    it('adds no pod membership for the row it took back', async () => {
      tokenArrivesDuringWrite();

      await seedNativeAgents();

      const user = await User.findOne({ 'botMetadata.agentName': CONFLICT }).lean();
      const demoPod = await Pod.findById(demoPodId).lean();
      expect(demoPod.members.map(String)).not.toContain(String(user._id));
    });
  });

  it('carries on when reading one identity fails', async () => {
    const realExists = User.exists.bind(User);
    jest.spyOn(User, 'exists').mockImplementation((filter, ...rest) => (
      String(filter?.username).includes(CONFLICT) ? Promise.reject(new Error('read failed')) : realExists(filter, ...rest)
    ));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(seedNativeAgents()).resolves.toBeUndefined();

    const others = await Promise.all(seeded.filter((name) => name !== CONFLICT).map(demoRow));
    expect(others.every(Boolean)).toBe(true);
  });
});
