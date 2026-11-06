/**
 * One runtime per agent identity. An identity runs in process or holds a token,
 * whichever came first, and the writers on both sides agree on it: the token
 * issuers, /install, the persona hire, and PATCH on an installed agent.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const AgentIdentityService = require('../../services/agentIdentityService');
const AgentMessageService = require('../../services/agentMessageService');
const { outsiderGrantPodRefusal } = require('../../services/outsiderGrantPodEligibility');
const { hirePersona, perUserInstanceId } = require('../../services/personaHireService');
const { FIRST_PARTY_APPS } = require('../../config/native-agents/apps');
const { buildInstallationConfig } = require('../../scripts/seed-native-agents');

const registryRoutes = require('../../routes/registry');

const JWT_SECRET = 'test-jwt-secret-install-token-identity';

jest.setTimeout(60000);

describe('installing an in-process runtime on an identity that holds a token', () => {
  let app;
  let owner;
  let ownerToken;
  let firstPod;
  let privatePod;
  const previousEngine = process.env.HOSTED_ENGINE;

  const install = (body) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(body);

  const byoSeat = async (agentName, instanceId = 'default') => {
    const res = await install({
      agentName,
      instanceId,
      podId: firstPod._id.toString(),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: [],
    });
    expect(res.status).toBe(200);
    return AgentInstallation.findOne({ agentName, instanceId, podId: firstPod._id });
  };

  const inProcessRow = (agentName, overrides = {}) => AgentInstallation.create({
    agentName,
    podId: firstPod._id,
    instanceId: 'default',
    version: '1.0.0',
    status: 'active',
    installedBy: owner._id,
    config: { runtime: { runtimeType: 'native' } },
    ...overrides,
  });

  const botUser = (agentName, instanceId = 'default') => User.findOne({
    username: AgentIdentityService.buildAgentUsername(agentName, instanceId), isBot: true,
  });

  const patchAgent = (token, podId, agentName, body) => request(app)
    .patch(`/api/registry/pods/${podId}/agents/${agentName}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  const holdsUserToken = async (agentName, instanceId = 'default') => {
    const user = await User.findOne({
      username: AgentIdentityService.buildAgentUsername(agentName, instanceId),
    }).select('+apiTokenHash');
    return Boolean(user?.apiTokenHash);
  };

  const giveUserToken = async (agentName, instanceId = 'default') => {
    const updated = await User.updateOne(
      { isBot: true, 'botMetadata.instanceId': instanceId, username: new RegExp(agentName) },
      { $push: { agentRuntimeTokens: { tokenHash: `hash-${agentName}`, label: 'test', createdAt: new Date() } } },
    );
    expect(updated.modifiedCount).toBe(1);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
  });

  afterAll(async () => {
    if (previousEngine === undefined) delete process.env.HOSTED_ENGINE;
    else process.env.HOSTED_ENGINE = previousEngine;
    await closeMongoDb();
  });

  beforeEach(async () => {
    process.env.HOSTED_ENGINE = 'native';
    await AgentInstallation.deleteMany({});
    await AgentRegistry.deleteMany({});
    await AgentProfile.deleteMany({});
    await Pod.deleteMany({});
    await User.deleteMany({});
    owner = await User.create({
      username: 'token-identity-owner',
      email: 'token-identity-owner@test.com',
      password: 'password123',
      entitlements: { cloudAgents: true },
    });
    ownerToken = jwt.sign({ id: owner._id.toString() }, JWT_SECRET);
    firstPod = await Pod.create({
      name: 'First', type: 'chat', createdBy: owner._id, members: [owner._id],
    });
    privatePod = await Pod.create({
      name: 'Private',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id],
      publicRead: false,
      joinPolicy: 'invite-only',
    });
  });

  it.each(['hosted', 'native', ' Native '])('refuses runtimeType %j when the bot user holds a token', async (runtimeType) => {
    await byoSeat('token-seat');
    await giveUserToken('token-seat');

    const res = await install({
      agentName: 'token-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType } },
      scopes: [],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('runtime_token_held');
    expect(await AgentInstallation.findOne({ agentName: 'token-seat', podId: privatePod._id })).toBeNull();
  });

  it('refuses when only a sibling installation holds the token', async () => {
    const seat = await byoSeat('legacy-seat');
    await AgentInstallation.updateOne(
      { _id: seat._id },
      { $push: { runtimeTokens: { tokenHash: 'hash-legacy', label: 'test', createdAt: new Date() } } },
    );

    const res = await install({
      agentName: 'legacy-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('runtime_token_held');
  });

  it('refuses before it writes anything', async () => {
    await byoSeat('token-seat');
    await giveUserToken('token-seat');
    const write = jest.spyOn(AgentInstallation, 'install');

    const res = await install({
      agentName: 'token-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });
    const calls = write.mock.calls.length;
    write.mockRestore();

    expect(res.status).toBe(409);
    expect(calls).toBe(0);
  });

  it('adds no row, so the pod stays free of that agent', async () => {
    await byoSeat('token-seat');
    await giveUserToken('token-seat');
    await install({
      agentName: 'token-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    const installed = await AgentInstallation.countDocuments({ podId: privatePod._id, agentName: 'token-seat' });
    expect(installed).toBe(0);
    expect(await outsiderGrantPodRefusal({ kind: 'pod', id: privatePod._id })).toBeNull();
  });

  it('still installs an identity with no token in process', async () => {
    await byoSeat('tokenless-seat');

    const res = await install({
      agentName: 'tokenless-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    expect(res.status).toBe(200);
  });

  it('leaves the Durable Object engine alone: that row polls with a token by design', async () => {
    process.env.HOSTED_ENGINE = '';
    await byoSeat('polling-seat');
    await giveUserToken('polling-seat');

    const res = await install({
      agentName: 'polling-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    expect(res.status).toBe(200);
  });

  it('leaves another bring-your-own install of the same identity alone', async () => {
    await byoSeat('second-pod-seat');
    await giveUserToken('second-pod-seat');

    const res = await install({
      agentName: 'second-pod-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: [],
    });

    expect(res.status).toBe(200);
  });

  describe('which identity a token belongs to', () => {
    it('refuses on a non-default instance whose bot user holds a token', async () => {
      await byoSeat('instance-seat', 'nova');
      await giveUserToken('instance-seat', 'nova');

      const res = await install({
        agentName: 'instance-seat',
        instanceId: 'nova',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
    });

    it('does not read a bot user token on another instance as this one\'s', async () => {
      await byoSeat('split-seat');
      await giveUserToken('split-seat');

      const res = await install({
        agentName: 'split-seat',
        instanceId: 'nova',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(200);
    });

    it('does not read an installation token on another instance as this one\'s', async () => {
      const seat = await byoSeat('split-row-seat');
      await AgentInstallation.updateOne(
        { _id: seat._id },
        { $push: { runtimeTokens: { tokenHash: 'hash-split', label: 'test', createdAt: new Date() } } },
      );

      const res = await install({
        agentName: 'split-row-seat',
        instanceId: 'nova',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(200);
    });

    it('matches an installation stored with a mixed-case instance', async () => {
      const seat = await byoSeat('mixed-seat', 'nova');
      await AgentInstallation.collection.updateOne(
        { _id: seat._id },
        {
          $set: {
            instanceId: 'NoVa',
            runtimeTokens: [{ tokenHash: 'hash-mixed', label: 'test', createdAt: new Date() }],
          },
        },
      );

      const res = await install({
        agentName: 'mixed-seat',
        instanceId: 'nova',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
    });

    it('refuses a manifest-declared native install that sends no type', async () => {
      const manifest = {
        name: 'declared-native',
        version: '1.0.0',
        description: 'Declared native.',
        capabilities: [],
        context: { required: [], optional: [] },
        runtime: { type: 'standalone', connection: 'rest', runtimeType: 'native' },
      };
      await AgentRegistry.create({
        agentName: 'declared-native',
        displayName: 'Declared',
        description: manifest.description,
        manifest,
        latestVersion: '1.0.0',
        versions: [{ version: '1.0.0', manifest, publishedAt: new Date() }],
        registry: 'private',
        publisher: { userId: owner._id, name: 'owner' },
      });
      await AgentIdentityService.getOrCreateAgentUser('declared-native', { instanceId: 'default' });
      await giveUserToken('declared-native');

      const res = await install({
        agentName: 'declared-native', podId: privatePod._id.toString(), scopes: [],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
    });
  });

  describe('where the refusal sits among the other install gates', () => {
    it('answers the entitlement gate first', async () => {
      await byoSeat('gated-seat');
      await giveUserToken('gated-seat');
      await User.updateOne({ _id: owner._id }, { $set: { entitlements: { cloudAgents: false } } });

      const res = await install({
        agentName: 'gated-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'native' } },
        scopes: [],
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('cloud_agents_not_entitled');
    });

    it('answers the hosted cap first', async () => {
      const previousCap = process.env.HOSTED_AGENTS_PER_USER;
      process.env.HOSTED_AGENTS_PER_USER = '1';
      try {
        await byoSeat('capped-seat');
        await giveUserToken('capped-seat');
        await AgentInstallation.create({
          agentName: 'other-hosted',
          podId: firstPod._id,
          instanceId: 'default',
          version: '1.0.0',
          installedBy: owner._id,
          config: { runtime: { runtimeType: 'hosted' } },
        });

        const res = await install({
          agentName: 'capped-seat',
          podId: privatePod._id.toString(),
          config: { runtime: { runtimeType: 'hosted' } },
          scopes: [],
        });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('hosted_cap_reached');
      } finally {
        if (previousCap === undefined) delete process.env.HOSTED_AGENTS_PER_USER;
        else process.env.HOSTED_AGENTS_PER_USER = previousCap;
      }
    });
  });

  describe('an identity whose last installation was uninstalled', () => {
    const uninstallSeat = async (seat) => {
      await AgentInstallation.updateOne({ _id: seat._id }, { $set: { status: 'uninstalled' } });
    };

    it('reinstalls in process, and the leftover token is revoked', async () => {
      const seat = await byoSeat('dormant-seat');
      await giveUserToken('dormant-seat');
      await uninstallSeat(seat);

      const res = await install({
        agentName: 'dormant-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(200);
      expect((await botUser('dormant-seat')).agentRuntimeTokens).toHaveLength(0);
    });

    it('revokes a leftover user token the same way', async () => {
      const seat = await byoSeat('dormant-user-seat');
      await User.mintApiTokenIfAbsent((await botUser('dormant-user-seat'))._id);
      await uninstallSeat(seat);

      const res = await install({
        agentName: 'dormant-user-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(200);
      expect(await holdsUserToken('dormant-user-seat')).toBe(false);
    });

    it('counts an identity with a live row as not dormant, and keeps its token', async () => {
      await byoSeat('mixed-state-seat');
      await giveUserToken('mixed-state-seat');
      await AgentInstallation.create({
        agentName: 'mixed-state-seat',
        podId: privatePod._id,
        instanceId: 'default',
        version: '1.0.0',
        status: 'uninstalled',
        installedBy: owner._id,
        config: { runtime: { runtimeType: 'webhook' } },
      });
      const write = jest.spyOn(AgentInstallation, 'install');

      const res = await install({
        agentName: 'mixed-state-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });
      const calls = write.mock.calls.length;
      write.mockRestore();

      expect(res.status).toBe(409);
      expect(calls).toBe(0);
      expect((await botUser('mixed-state-seat')).agentRuntimeTokens).toHaveLength(1);
    });

    it('still refuses while another row of the identity is live', async () => {
      await byoSeat('paused-seat');
      await giveUserToken('paused-seat');
      await AgentInstallation.updateOne(
        { agentName: 'paused-seat', podId: firstPod._id }, { $set: { status: 'paused' } },
      );

      const res = await install({
        agentName: 'paused-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
    });
  });

  describe('the check after the row is written', () => {
    let realInstall;

    const installWritesToken = (agentName) => {
      realInstall = AgentInstallation.install.bind(AgentInstallation);
      return jest.spyOn(AgentInstallation, 'install').mockImplementation(async (...args) => {
        await giveUserToken(agentName);
        return realInstall(...args);
      });
    };

    afterEach(() => jest.restoreAllMocks());

    it('removes a new row and its pod membership on refusal', async () => {
      await byoSeat('settled-seat');
      installWritesToken('settled-seat');

      const res = await install({
        agentName: 'settled-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
      expect(await AgentInstallation.findOne({ agentName: 'settled-seat', podId: privatePod._id })).toBeNull();
      const pod = await Pod.findById(privatePod._id).lean();
      const bot = await botUser('settled-seat');
      expect(pod.members.map(String)).not.toContain(String(bot._id));
      expect(await AgentProfile.countDocuments({ agentName: 'settled-seat', podId: privatePod._id })).toBe(0);
    });

    it('puts a row that existed back as it was, and keeps its membership', async () => {
      await byoSeat('restored-seat');
      await AgentInstallation.create({
        agentName: 'restored-seat',
        podId: privatePod._id,
        instanceId: 'default',
        version: '1.0.0',
        status: 'paused',
        installedBy: owner._id,
        config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
      });
      const bot = await botUser('restored-seat');
      await Pod.updateOne({ _id: privatePod._id }, { $push: { members: bot._id } });
      installWritesToken('restored-seat');

      const res = await install({
        agentName: 'restored-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(409);
      const row = await AgentInstallation.findOne({ agentName: 'restored-seat', podId: privatePod._id }).lean();
      expect(row.status).toBe('paused');
      expect(row.config.runtime.runtimeType).toBe('webhook');
      const pod = await Pod.findById(privatePod._id).lean();
      expect(pod.members.map(String)).toContain(String(bot._id));
    });
  });

  describe('hiring a persona', () => {
    const persona = FIRST_PARTY_APPS.find((app) => !app.perUser);

    const seedPersona = async () => {
      const manifest = {
        name: persona.agentName,
        version: '1.0.0',
        description: 'Persona.',
        capabilities: [],
        context: { required: [], optional: [] },
        runtime: { type: 'standalone', connection: 'rest' },
      };
      await AgentRegistry.create({
        agentName: persona.agentName,
        displayName: persona.displayName,
        description: manifest.description,
        manifest,
        latestVersion: '1.0.0',
        versions: [{ version: '1.0.0', manifest, publishedAt: new Date() }],
        registry: 'private',
        publisher: { userId: owner._id, name: 'owner' },
        verified: true,
      });
      return perUserInstanceId(String(owner._id));
    };

    const seededBot = (instanceId) => AgentIdentityService.getOrCreateAgentUser(persona.agentName, { instanceId });

    const hire = () => hirePersona({
      agentName: persona.agentName, userId: String(owner._id), podId: String(privatePod._id),
    });

    beforeEach(() => {
      jest.spyOn(AgentMessageService, 'postMessage').mockResolvedValue({ success: true });
    });

    afterEach(() => jest.restoreAllMocks());

    it('runs in process', () => {
      expect(buildInstallationConfig(persona).runtime.runtimeType).toBe('native');
    });

    it('refuses when the per-user identity holds a token, and writes no row', async () => {
      const instanceId = await seedPersona();
      const bot = await seededBot(instanceId);
      await User.updateOne(
        { _id: bot._id },
        { $push: { agentRuntimeTokens: { tokenHash: 'hash-hire', label: 'test', createdAt: new Date() } } },
      );

      await expect(hire()).rejects.toMatchObject({ code: 'runtime_token_held', status: 409 });
      expect(await AgentInstallation.countDocuments({ agentName: persona.agentName })).toBe(0);
    });

    it('hires an identity with no token', async () => {
      const instanceId = await seedPersona();

      await expect(hire()).resolves.toMatchObject({ instanceId, agentName: persona.agentName });
      expect(await AgentInstallation.countDocuments({
        agentName: persona.agentName, instanceId, status: 'active',
      })).toBe(1);
    });

    it('revokes what a dormant identity left behind, as a reinstall does', async () => {
      const instanceId = await seedPersona();
      const bot = await seededBot(instanceId);
      await User.updateOne(
        { _id: bot._id },
        { $push: { agentRuntimeTokens: { tokenHash: 'hash-hire-3', label: 'test', createdAt: new Date() } } },
      );
      await inProcessRow(persona.agentName, { instanceId, status: 'uninstalled' });

      await expect(hire()).resolves.toMatchObject({ instanceId });
      expect((await User.findById(bot._id)).agentRuntimeTokens).toHaveLength(0);
    });

    it('removes the row when the check after the write refuses', async () => {
      const instanceId = await seedPersona();
      const bot = await seededBot(instanceId);
      const real = AgentInstallation.findOneAndUpdate.bind(AgentInstallation);
      jest.spyOn(AgentInstallation, 'findOneAndUpdate').mockImplementation(async (...args) => {
        await User.updateOne(
          { _id: bot._id },
          { $push: { agentRuntimeTokens: { tokenHash: 'hash-hire-2', label: 'test', createdAt: new Date() } } },
        );
        return real(...args);
      });

      await expect(hire()).rejects.toMatchObject({ code: 'runtime_token_held', status: 409 });
      expect(await AgentInstallation.countDocuments({ agentName: persona.agentName })).toBe(0);
      const pod = await Pod.findById(privatePod._id).lean();
      expect(pod.members.map(String)).not.toContain(String(bot._id));
    });
  });

  describe('PATCH on an installed agent', () => {
    let adminToken;

    beforeEach(async () => {
      const admin = await User.create({
        username: 'token-identity-admin',
        email: 'token-identity-admin@test.com',
        password: 'password123',
        role: 'admin',
      });
      adminToken = jwt.sign({ id: admin._id.toString() }, JWT_SECRET);
    });

    afterEach(() => jest.restoreAllMocks());

    it('refuses to return a row to active while the identity holds a token', async () => {
      await byoSeat('held-seat');
      await giveUserToken('held-seat');
      await inProcessRow('held-seat', { podId: privatePod._id, status: 'paused' });

      const res = await patchAgent(ownerToken, privatePod._id, 'held-seat', { status: 'active' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
      const row = await AgentInstallation.findOne({ agentName: 'held-seat', podId: privatePod._id }).lean();
      expect(row.status).toBe('paused');
    });

    it('refuses before it saves anything', async () => {
      await byoSeat('held-seat');
      await giveUserToken('held-seat');
      await inProcessRow('held-seat', { podId: privatePod._id, status: 'paused' });
      const save = jest.spyOn(AgentInstallation.prototype, 'save');

      const res = await patchAgent(ownerToken, privatePod._id, 'held-seat', { status: 'active' });
      const calls = save.mock.calls.length;
      save.mockRestore();

      expect(res.status).toBe(409);
      expect(calls).toBe(0);
    });

    it.each(['stale', 'error'])('reads a row marked %s the same way', async (status) => {
      await byoSeat('held-seat');
      await giveUserToken('held-seat');
      await inProcessRow('held-seat', { podId: privatePod._id, status });

      const res = await patchAgent(ownerToken, privatePod._id, 'held-seat', { status: 'active' });

      expect(res.status).toBe(409);
    });

    it('reads a hosted row on the native engine as in process', async () => {
      await byoSeat('held-hosted-seat');
      await giveUserToken('held-hosted-seat');
      await inProcessRow('held-hosted-seat', {
        podId: privatePod._id,
        status: 'paused',
        config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native' } },
      });

      const res = await patchAgent(ownerToken, privatePod._id, 'held-hosted-seat', { status: 'active' });

      expect(res.status).toBe(409);
    });

    it('returns a row to active when the identity holds no token', async () => {
      await inProcessRow('clear-seat', { status: 'paused' });

      const res = await patchAgent(ownerToken, firstPod._id, 'clear-seat', { status: 'active' });

      expect(res.status).toBe(200);
      expect((await AgentInstallation.findOne({ agentName: 'clear-seat' }).lean()).status).toBe('active');
    });

    it('returns a bring-your-own row to active with its token', async () => {
      const seat = await byoSeat('byo-seat');
      await giveUserToken('byo-seat');
      await AgentInstallation.updateOne({ _id: seat._id }, { $set: { status: 'paused' } });

      const res = await patchAgent(ownerToken, firstPod._id, 'byo-seat', { status: 'active' });

      expect(res.status).toBe(200);
    });

    it('leaves a save that keeps an active row active alone', async () => {
      await byoSeat('kept-seat');
      await giveUserToken('kept-seat');
      await inProcessRow('kept-seat', { podId: privatePod._id });

      const res = await patchAgent(ownerToken, privatePod._id, 'kept-seat', { status: 'active' });

      expect(res.status).toBe(200);
    });

    it('still pauses a row', async () => {
      await byoSeat('pausing-seat');
      await giveUserToken('pausing-seat');
      await inProcessRow('pausing-seat', { podId: privatePod._id });

      const res = await patchAgent(ownerToken, privatePod._id, 'pausing-seat', { status: 'paused' });

      expect(res.status).toBe(200);
    });

    it('refuses an admin type change to native while the identity holds a token', async () => {
      await byoSeat('typed-seat');
      await giveUserToken('typed-seat');

      const res = await patchAgent(adminToken, firstPod._id, 'typed-seat', {
        config: { runtime: { runtimeType: 'native' } },
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
      const row = await AgentInstallation.findOne({ agentName: 'typed-seat' }).lean();
      expect(row.config.runtime.runtimeType).toBe('webhook');
    });

    it('allows an admin type change to native with no token', async () => {
      await byoSeat('typed-clear-seat');

      const res = await patchAgent(adminToken, firstPod._id, 'typed-clear-seat', {
        config: { runtime: { runtimeType: 'native' } },
      });

      expect(res.status).toBe(200);
    });

    it('puts the rows back when the check after the save refuses', async () => {
      await byoSeat('undone-seat');
      const realSave = AgentInstallation.prototype.save;
      jest.spyOn(AgentInstallation.prototype, 'save').mockImplementation(async function save(...args) {
        await giveUserToken('undone-seat');
        return realSave.apply(this, args);
      });

      const res = await patchAgent(adminToken, firstPod._id, 'undone-seat', {
        config: { runtime: { runtimeType: 'native' } },
      });

      expect(res.status).toBe(409);
      const row = await AgentInstallation.findOne({ agentName: 'undone-seat' }).lean();
      expect(row.config.runtime.runtimeType).toBe('webhook');
    });
  });

  describe('the token issuers', () => {
    const mint = (podId, agentName) => request(app)
      .post(`/api/registry/pods/${podId}/agents/${agentName}/runtime-tokens`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'test' });

    const mintUserToken = (podId, agentName, body = {}) => request(app)
      .post(`/api/registry/pods/${podId}/agents/${agentName}/user-token`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);

    it.each(['paused', 'stale', 'error'])('count an in-process row marked %s', async (status) => {
      await byoSeat('issuer-seat');
      await inProcessRow('issuer-seat', { podId: privatePod._id, status });

      const res = await mint(firstPod._id, 'issuer-seat');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('in_process_agent_no_token');
    });

    it('ignore an uninstalled in-process row', async () => {
      await byoSeat('issuer-open-seat');
      await inProcessRow('issuer-open-seat', { podId: privatePod._id, status: 'uninstalled' });

      const res = await mint(firstPod._id, 'issuer-open-seat');

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.stringMatching(/^cm_agent_/));
    });

    it('match an in-process row stored with a mixed-case instance', async () => {
      await byoSeat('issuer-mixed-seat', 'nova');
      await inProcessRow('issuer-mixed-seat', { podId: privatePod._id, instanceId: 'nova' });
      await AgentInstallation.collection.updateOne(
        { agentName: 'issuer-mixed-seat', podId: privatePod._id }, { $set: { instanceId: 'NoVa' } },
      );

      const res = await request(app)
        .post(`/api/registry/pods/${firstPod._id}/agents/issuer-mixed-seat/runtime-tokens?instanceId=nova`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ label: 'test', instanceId: 'nova' });

      expect(res.status).toBe(409);
    });

    it('refuse a user token to an in-process identity', async () => {
      await inProcessRow('user-token-seat');
      await AgentIdentityService.getOrCreateAgentUser('user-token-seat', { instanceId: 'default' });

      const res = await mintUserToken(firstPod._id, 'user-token-seat');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('in_process_agent_no_token');
      expect(await holdsUserToken('user-token-seat')).toBe(false);
    });

    it('leave an existing user token as it was on refusal', async () => {
      await inProcessRow('user-kept-seat');
      const bot = await AgentIdentityService.getOrCreateAgentUser('user-kept-seat', { instanceId: 'default' });
      await User.mintApiTokenIfAbsent(bot._id, { apiTokenScopes: ['agent:events:read'] });

      const res = await mintUserToken(firstPod._id, 'user-kept-seat', { scopes: ['agent:messages:write'] });

      expect(res.status).toBe(409);
      expect((await User.findById(bot._id).lean()).apiTokenScopes).toEqual(['agent:events:read']);
    });

    it('refuse a forced user token the same way', async () => {
      await inProcessRow('user-force-seat');
      await AgentIdentityService.getOrCreateAgentUser('user-force-seat', { instanceId: 'default' });

      const res = await mintUserToken(firstPod._id, 'user-force-seat', { force: true });

      expect(res.status).toBe(409);
      expect(await holdsUserToken('user-force-seat')).toBe(false);
    });

    it('take a user token back when the check after the mint refuses', async () => {
      await byoSeat('user-late-seat');
      const realMint = User.mintApiTokenIfAbsent.bind(User);
      jest.spyOn(User, 'mintApiTokenIfAbsent').mockImplementation(async (...args) => {
        await inProcessRow('user-late-seat', { podId: privatePod._id });
        return realMint(...args);
      });

      const res = await mintUserToken(firstPod._id, 'user-late-seat');
      jest.restoreAllMocks();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('in_process_agent_no_token');
      expect(await holdsUserToken('user-late-seat')).toBe(false);
    });

    it('still give a user token to a bring-your-own identity', async () => {
      await byoSeat('user-open-seat');

      const res = await mintUserToken(firstPod._id, 'user-open-seat');

      expect(res.status).toBe(200);
      expect(await holdsUserToken('user-open-seat')).toBe(true);
    });

    it('refuse an admin session token to an in-process identity', async () => {
      const admin = await User.create({
        username: 'session-admin',
        email: 'session-admin@test.com',
        password: 'password123',
        role: 'admin',
      });
      await inProcessRow('claude-code', { instanceId: 'session-seat' });

      const res = await request(app)
        .post('/api/registry/admin/agents/claude-code/session-token')
        .set('Authorization', `Bearer ${jwt.sign({ id: admin._id.toString() }, JWT_SECRET)}`)
        .send({ podId: firstPod._id.toString(), instanceId: 'session-seat' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('in_process_agent_no_token');
    });
  });

  describe('a user token on the install side', () => {
    it('refuses an in-process install on an identity that holds one', async () => {
      await byoSeat('cm-seat');
      await User.mintApiTokenIfAbsent((await botUser('cm-seat'))._id);

      const res = await install({
        agentName: 'cm-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
    });

    it('installs once the token is revoked', async () => {
      await byoSeat('cm-revoked-seat');
      await User.mintApiTokenIfAbsent((await botUser('cm-revoked-seat'))._id);

      const revoked = await request(app)
        .delete(`/api/registry/pods/${firstPod._id}/agents/cm-revoked-seat/user-token`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revoked.status).toBe(200);

      const res = await install({
        agentName: 'cm-revoked-seat',
        podId: privatePod._id.toString(),
        config: { runtime: { runtimeType: 'hosted' } },
        scopes: [],
      });

      expect(res.status).toBe(200);
    });
  });
});
