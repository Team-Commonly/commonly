// The hosted cap is about agents, and an agent has one row per room. These run on
// a real mongod because every claim here is about which rows a query matches: a
// mocked model only reports the filter it was handed. In particular the route
// hands the query a string user id, which Mongoose casts in a find and which an
// aggregate $match would silently match nothing with.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../services/firstContactService', () => ({ maybeFireFirstContact: jest.fn().mockResolvedValue(false) }));
jest.mock('../../services/starterTaskService', () => ({
  ...jest.requireActual('../../services/starterTaskService'),
  completeConnectAgentStarterTask: jest.fn().mockResolvedValue(undefined),
}));

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const hostedRuntime = require('../../services/hostedRuntimeService');
const { completeConnectAgentStarterTask } = require('../../services/starterTaskService');
const { revokeRuntimeTokensForAgent } = require('../../routes/registry/tokens');
const installRouter = require('../../routes/registry/install');
const hostedRouter = require('../../routes/hosted');

const SECRET = 'hosted-cap-counts-agents-test';
const NAME = 'cap-agent';
const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;

const seedRow = (installedBy, podId, overrides = {}) => AgentInstallation.collection.insertOne({
  agentName: NAME,
  instanceId: 'default',
  podId,
  installedBy,
  version: '1.0.0',
  status: 'active',
  displayName: 'Cap agent',
  config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date(), about: 'Keeps the log.' } },
  ...overrides,
});

describe('the hosted cap counts agents, not rooms', () => {
  let app; let owner; let other; let podA; let podB; let podC;
  const saved = {};

  const install = (user, body) => request(app).post('/api/registry/install')
    .set('Authorization', bearer(user))
    .send({ scopes: [], config: { runtime: { runtimeType: 'hosted' } }, ...body });

  const seedRegistry = (publisherId, ephemeral = true) => AgentRegistry.create({
    agentName: NAME,
    displayName: 'Cap agent',
    description: 'A connected agent.',
    manifest: { name: NAME, version: '1.0.0', description: 'A connected agent.', capabilities: [], context: { required: [], optional: [] }, runtime: { type: 'standalone', connection: 'rest' } },
    latestVersion: '1.0.0',
    versions: [{ version: '1.0.0', manifest: { name: NAME, version: '1.0.0', description: 'A connected agent.', runtime: { type: 'standalone', connection: 'rest' } }, publishedAt: new Date() }],
    registry: 'private',
    publisher: { userId: publisherId, name: 'owner' },
    ephemeral,
  });

  beforeAll(async () => {
    ['JWT_SECRET', 'HOSTED_ENGINE', 'HOSTED_AGENTS_PER_USER', 'LITELLM_BASE_URL', 'LITELLM_MASTER_KEY', 'HOSTED_RUNTIME_URL', 'HOSTED_RUNTIME_ADMIN_TOKEN']
      .forEach((key) => { saved[key] = process.env[key]; });
    process.env.JWT_SECRET = SECRET;
    process.env.HOSTED_RUNTIME_URL = 'http://hosted-runtime.test';
    process.env.HOSTED_RUNTIME_ADMIN_TOKEN = 'admin-token';
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', installRouter);
    app.use('/api/hosted', hostedRouter);
    owner = await User.create({ username: 'cap-owner', email: 'cap-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'cap-other', email: 'cap-other@test.com', password: 'password123' });
    const pod = (name) => Pod.create({ name, type: 'chat', createdBy: owner._id, members: [owner._id, other._id] });
    [podA, podB, podC] = await Promise.all([pod('Cap A'), pod('Cap B'), pod('Cap C')]);
  });

  afterAll(async () => {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await closeMongoDb();
  });

  beforeEach(async () => {
    process.env.HOSTED_ENGINE = 'native';
    process.env.HOSTED_AGENTS_PER_USER = '1';
    await AgentInstallation.deleteMany({});
    await AgentRegistry.deleteMany({});
    await User.deleteMany({ isBot: true });
    jest.restoreAllMocks();
  });

  describe('countHostedAgentsForUser', () => {
    it('counts one agent in two rooms once, given the string id the route passes', async () => {
      await seedRow(owner._id, podA._id);
      await seedRow(owner._id, podB._id);
      await expect(hostedRuntime.countHostedAgentsForUser(String(owner._id))).resolves.toBe(1);
    });

    it('counts different names and different instances apart', async () => {
      await seedRow(owner._id, podA._id);
      await seedRow(owner._id, podB._id, { agentName: 'second-agent' });
      await seedRow(owner._id, podC._id, { instanceId: 'demo' });
      await expect(hostedRuntime.countHostedAgentsForUser(String(owner._id))).resolves.toBe(3);
    });

    it('folds case and a missing instance the way identity does', async () => {
      await seedRow(owner._id, podA._id, { instanceId: 'Demo' });
      await seedRow(owner._id, podB._id, { instanceId: 'demo' });
      await seedRow(owner._id, podC._id, { agentName: 'second-agent', instanceId: undefined });
      await seedRow(owner._id, new mongoose.Types.ObjectId(), { agentName: 'second-agent', instanceId: 'default' });
      await expect(hostedRuntime.countHostedAgentsForUser(String(owner._id))).resolves.toBe(2);
    });

    it("leaves out other owners' rows, uninstalled rows and rows that are not hosted", async () => {
      await seedRow(other._id, podA._id);
      await seedRow(owner._id, podB._id, { status: 'uninstalled' });
      await seedRow(owner._id, podC._id, { config: { runtime: { runtimeType: 'webhook' } } });
      await expect(hostedRuntime.countHostedAgentsForUser(String(owner._id))).resolves.toBe(0);
    });

    it('does not load config, on the count or the list', async () => {
      await seedRow(owner._id, podA._id);
      const seen = [];
      const realExec = mongoose.Query.prototype.exec;
      jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function exec(...args) {
        if (this.model === AgentInstallation) seen.push(this.projection());
        return realExec.apply(this, args);
      });
      await hostedRuntime.countHostedAgentsForUser(String(owner._id));
      await hostedRuntime.listHostedInstallationsForUser(String(owner._id));
      expect(seen).toHaveLength(2);
      seen.forEach((projection) => {
        expect(Object.keys(projection).some((path) => path.startsWith('config'))).toBe(false);
      });
    });
  });

  describe('listHostedInstallationsForUser', () => {
    it('names one agent once, at the room it first joined, with owner-safe fields only', async () => {
      await seedRow(owner._id, podA._id);
      await seedRow(owner._id, podB._id);
      await expect(hostedRuntime.listHostedInstallationsForUser(String(owner._id))).resolves.toEqual([
        { agentName: NAME, instanceId: 'default', podId: String(podA._id), displayName: 'Cap agent' },
      ]);
    });
  });

  describe('POST /install', () => {
    const heldInTwoRooms = async () => {
      await seedRegistry(owner._id);
      await seedRow(owner._id, podA._id);
      await seedRow(owner._id, podB._id);
    };

    it('adds the agent the person holds to another pod, and it costs no second agent', async () => {
      await heldInTwoRooms();
      const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      expect(res.status).toBe(200);
      const rows = await AgentInstallation.find({ agentName: NAME, status: 'active' }).lean();
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.instanceId))).toEqual(new Set(['default']));
      await expect(hostedRuntime.countHostedAgentsForUser(String(owner._id))).resolves.toBe(1);
    });

    it('compares the identity the install writes: a name-as-display maps to default', async () => {
      await heldInTwoRooms();
      const res = await install(owner, { agentName: NAME.toUpperCase(), podId: String(podC._id), instanceId: NAME });
      expect(res.status).toBe(200);
    });

    it('treats another instance of the same name as a new agent, and reports agents in used', async () => {
      await heldInTwoRooms();
      const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: 'Other persona' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 1, cap: 1 });
      expect(res.body.holders).toEqual([expect.objectContaining({ agentName: NAME, instanceId: 'default' })]);
      expect(await AgentInstallation.countDocuments({ podId: podC._id })).toBe(0);
    });

    it('refuses a new name at the cap, and writes no registry row', async () => {
      await heldInTwoRooms();
      const res = await install(owner, { agentName: 'brand-new', podId: String(podC._id), displayName: 'brand-new' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 1, cap: 1 });
      expect(await AgentRegistry.countDocuments({ agentName: 'brand-new' })).toBe(0);
    });

    it('the self-serve check lets the held agent through too, when no registry row is left', async () => {
      await seedRow(owner._id, podA._id);
      const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      expect(res.status).toBe(200);
    });

    it('a cap of 0 refuses even an agent the person holds', async () => {
      await heldInTwoRooms();
      process.env.HOSTED_AGENTS_PER_USER = '0';
      const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 1, cap: 0 });
    });

    it('a cap lowered under what the person holds refuses, as provision would one call later', async () => {
      await heldInTwoRooms();
      await seedRow(owner._id, new mongoose.Types.ObjectId(), { agentName: 'second-agent' });
      const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 2, cap: 1 });
    });

    it("another person's row of that name does not make it held", async () => {
      // A published agent is multi-installer, so the #609 guard does not answer first.
      await seedRegistry(other._id, false);
      await seedRow(other._id, podA._id);
      await seedRow(owner._id, podB._id, { agentName: 'owners-own' });
      const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 1, cap: 1 });
    });

    it("holding a name does not let anyone else's row through", async () => {
      await heldInTwoRooms();
      const res = await install(other, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('agent_name_taken');
    });

    it('a row in a pod where it already is stays the same refusal', async () => {
      await heldInTwoRooms();
      const res = await install(owner, { agentName: NAME, podId: String(podA._id), displayName: NAME });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already installed/i);
    });

    it('carries the persona sentence into the new room', async () => {
      await heldInTwoRooms();
      await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      const row = await AgentInstallation.findOne({ agentName: NAME, podId: podC._id }).lean();
      expect(row.config.hosted).toMatchObject({ engine: 'native', about: 'Keeps the log.' });
    });

    it('a stopped agent added to another pod stays stopped there', async () => {
      await heldInTwoRooms();
      await request(app).post('/api/hosted/deprovision')
        .set('Authorization', bearer(owner)).send({ agentName: NAME });
      await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      const rows = await AgentInstallation.find({ agentName: NAME }).lean();
      expect(rows.map((row) => row.config.hosted.provisionedAt)).toEqual([null, null, null]);
    });

    it('a running agent added to another pod is running there', async () => {
      await heldInTwoRooms();
      await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
      const row = await AgentInstallation.findOne({ agentName: NAME, podId: podC._id }).lean();
      expect(row.config.hosted.provisionedAt).toBeTruthy();
    });

    describe('one runtime per identity', () => {
      const giveBotToken = () => User.create({
        username: NAME,
        email: 'cap-bot@test.com',
        password: 'password123',
        isBot: true,
        botMetadata: { agentName: NAME, instanceId: 'default', ownerUserId: String(owner._id) },
        agentRuntimeTokens: [{ tokenHash: 'hash', label: 'Hosted runtime' }],
      });

      it('an agent on the Durable Object stays on it, so its own token does not refuse the re-add', async () => {
        await seedRegistry(owner._id);
        await seedRow(owner._id, podA._id, { config: { runtime: { runtimeType: 'hosted' }, hosted: { provisionedAt: new Date() } } });
        await giveBotToken();
        const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
        expect(res.status).toBe(200);
        const row = await AgentInstallation.findOne({ agentName: NAME, podId: podC._id }).lean();
        expect(row.config.hosted?.engine).toBeUndefined();
      });

      it('an agent on the native engine stays on it wherever the instance default points', async () => {
        await seedRegistry(owner._id);
        await seedRow(owner._id, podA._id);
        delete process.env.HOSTED_ENGINE;
        const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
        expect(res.status).toBe(200);
        const row = await AgentInstallation.findOne({ agentName: NAME, podId: podC._id }).lean();
        expect(row.config.hosted).toMatchObject({ engine: 'native' });
      });

      it('a native agent that somehow holds a token is still refused, and no row stays', async () => {
        await heldInTwoRooms();
        await giveBotToken();
        const res = await install(owner, { agentName: NAME, podId: String(podC._id), displayName: NAME });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('runtime_token_held');
        expect(await AgentInstallation.countDocuments({ podId: podC._id })).toBe(0);
      });
    });
  });

  describe('POST /provision and /deprovision after a re-add', () => {
    const provisionByName = (body) => request(app).post('/api/hosted/provision')
      .set('Authorization', bearer(owner)).send(body);

    beforeEach(async () => {
      await seedRegistry(owner._id);
      await User.create({
        username: `${NAME}-persona`,
        email: 'cap-persona@test.com',
        password: 'password123',
        isBot: true,
        botMetadata: { agentName: NAME, instanceId: 'persona' },
      });
      await seedRow(owner._id, podA._id, { instanceId: 'persona' });
      await seedRow(owner._id, podB._id, { instanceId: 'persona' });
      await seedRow(owner._id, podC._id, { instanceId: 'persona' });
    });

    it('one instance in three rooms is not ambiguous, and is not over the cap', async () => {
      const res = await provisionByName({ agentName: NAME });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ provisioned: true, instanceId: 'persona' });
    });

    it('two instances are still ambiguous', async () => {
      process.env.HOSTED_AGENTS_PER_USER = '2';
      await seedRow(owner._id, new mongoose.Types.ObjectId(), { instanceId: 'other' });
      const res = await provisionByName({ agentName: NAME });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ambiguous_instance');
    });

    it('stopping the agent stops it in every room, and starting it starts them all', async () => {
      const stop = await request(app).post('/api/hosted/deprovision')
        .set('Authorization', bearer(owner)).send({ agentName: NAME });
      expect(stop.status).toBe(200);
      let rows = await AgentInstallation.find({ agentName: NAME }).lean();
      expect(rows.map((row) => row.config.hosted.provisionedAt)).toEqual([null, null, null]);
      expect((await provisionByName({ agentName: NAME })).status).toBe(200);
      rows = await AgentInstallation.find({ agentName: NAME }).lean();
      rows.forEach((row) => expect(row.config.hosted.provisionedAt).toBeTruthy());
    });

    it('folds a case variant of the instance into the same agent, for resolving and for stopping', async () => {
      await seedRow(owner._id, new mongoose.Types.ObjectId(), { instanceId: 'Persona' });
      const stop = await request(app).post('/api/hosted/deprovision')
        .set('Authorization', bearer(owner)).send({ agentName: NAME });
      expect(stop.status).toBe(200);
      const rows = await AgentInstallation.find({ agentName: NAME }).lean();
      expect(rows).toHaveLength(4);
      rows.forEach((row) => expect(row.config.hosted.provisionedAt).toBeNull());
    });

    it('a row saved before instance ids belongs to default, for stopping', async () => {
      await AgentInstallation.deleteMany({ agentName: NAME });
      await seedRow(owner._id, podA._id);
      await seedRow(owner._id, podB._id, { instanceId: null });
      await request(app).post('/api/hosted/deprovision')
        .set('Authorization', bearer(owner)).send({ agentName: NAME, instanceId: 'default' });
      const rows = await AgentInstallation.find({ agentName: NAME }).lean();
      rows.forEach((row) => expect(row.config.hosted.provisionedAt).toBeNull());
    });

    it('a rotation reaches a token on a row saved before instance ids', async () => {
      const legacy = await seedRow(owner._id, podB._id, {
        instanceId: null, agentName: 'legacy-agent', runtimeTokens: [{ tokenHash: 'legacy-hash' }],
      });
      await seedRow(owner._id, podA._id, { agentName: 'legacy-agent', instanceId: 'default' });
      const revoked = await revokeRuntimeTokensForAgent({ agentName: 'legacy-agent', instanceId: 'default' });
      expect(revoked).toContain('legacy-hash');
      const row = await AgentInstallation.findById(legacy.insertedId).lean();
      expect(row.runtimeTokens).toEqual([]);
    });

    it('completes the connect-agent task in every room the agent starts in', async () => {
      completeConnectAgentStarterTask.mockClear();
      await provisionByName({ agentName: NAME });
      expect(completeConnectAgentStarterTask).toHaveBeenCalledTimes(1);
      const { podIds } = completeConnectAgentStarterTask.mock.calls[0][0];
      expect(podIds.map(String).sort()).toEqual([podA, podB, podC].map((pod) => String(pod._id)).sort());
    });

    it("leaves another person's row of the identity alone", async () => {
      const theirs = await seedRow(other._id, new mongoose.Types.ObjectId(), { instanceId: 'persona' });
      await request(app).post('/api/hosted/deprovision')
        .set('Authorization', bearer(owner)).send({ agentName: NAME });
      const row = await AgentInstallation.findById(theirs.insertedId).lean();
      expect(row.config.hosted.provisionedAt).toBeTruthy();
    });
  });

  describe('the hosted turn meter', () => {
    const AgentRun = require('../../models/AgentRun');
    const run = (userId) => AgentRun.collection.insertOne({
      agentName: NAME, instanceId: 'default', podId: podA._id, userId, startedAt: new Date(), trigger: 'chat.mention',
    });

    it("counts one owner's runs across rooms, and not another owner's of a shared agent", async () => {
      await AgentRun.deleteMany({ agentName: NAME });
      await run(String(owner._id));
      await run(String(owner._id));
      await run(String(other._id));
      await expect(hostedRuntime.nativeTurnsToday(NAME, 'default', String(owner._id))).resolves.toBe(2);
    });
  });

  describe('GET /availability', () => {
    const availability = (user) => request(app).get('/api/hosted/availability').set('Authorization', bearer(user));

    it('names the held agent to its holder, and to nobody else', async () => {
      await seedRow(owner._id, podA._id);
      await seedRow(owner._id, podB._id);
      expect((await availability(owner)).body.held).toEqual({
        agentName: NAME, instanceId: 'default', podId: String(podA._id), displayName: 'Cap agent',
      });
      expect((await availability(other)).body.held).toBeNull();
    });

    it('stays null for an admin, whom the cap does not refuse', async () => {
      const admin = await User.create({ username: 'cap-admin', email: 'cap-admin@test.com', password: 'password123', role: 'admin' });
      await seedRow(admin._id, podA._id);
      expect((await availability(admin)).body.held).toBeNull();
    });

    it('says a cap of 0 is full with nobody holding it, and never to an admin', async () => {
      process.env.HOSTED_AGENTS_PER_USER = '0';
      expect((await availability(owner)).body).toMatchObject({ held: null, full: true });
      const admin = await User.findOne({ username: 'cap-admin' })
        || await User.create({ username: 'cap-admin', email: 'cap-admin@test.com', password: 'password123', role: 'admin' });
      expect((await availability(admin)).body).toMatchObject({ held: null, full: false });
    });

    it('stays null while the person has room', async () => {
      process.env.HOSTED_AGENTS_PER_USER = '2';
      await seedRow(owner._id, podA._id);
      expect((await availability(owner)).body.held).toBeNull();
    });
  });
});
