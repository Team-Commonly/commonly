// Who an agent's DM rows say owns it. A row in an agent-room is written when
// someone opens a DM, and it names whoever opened it, so it says who is talking
// to the agent and not who owns it. Real mongod, through the real routes,
// because every claim here is about which rows the rule reaches.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentCredential = require('../../models/AgentCredential');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const {
  describeRuntimeIdentityBlockers, identityHoldsRuntimeToken, ownsRuntimeIdentity, willSolelyInstallRuntimeIdentity,
} = require('../../services/runtimeIdentityOwnership');
const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');
const credentialRoutes = require('../../routes/credentials');
const agentBindingRoutes = require('../../routes/agentBinding');

const SECRET = 'room-rows-ownership-test';

jest.setTimeout(60000);

describe('an agent-room row and who owns the agent', () => {
  let app; let owner; let guest; let third; let home;
  let NAME;
  let seq = 0;
  const saved = {};

  const person = () => {
    seq += 1;
    return User.create({ username: `room-rows-${seq}`, email: `room-rows-${seq}@test.invalid`, password: 'password123' });
  };
  const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;
  const pod = (name, members, extra = {}) => Pod.create({ name, type: 'chat', createdBy: members[0], members, ...extra });
  const installOwner = () => request(app).post('/api/registry/install')
    .set('Authorization', bearer(owner))
    .send({ agentName: NAME, podId: String(home._id), scopes: [], config: { runtime: { runtimeType: 'webhook' } } });
  const openDm = async (user) => {
    const res = await request(app).post('/api/agents/runtime/room').set('Authorization', bearer(user))
      .send({ agentName: NAME, instanceId: 'default' });
    expect(res.status).toBe(200);
    return res.body.room._id;
  };
  const mint = (user, podId) => request(app).post(`/api/registry/pods/${podId}/agents/${NAME}/runtime-tokens`)
    .set('Authorization', bearer(user)).send({ label: 'test' });
  const setWebhook = (user, podId) => request(app).patch(`/api/registry/pods/${podId}/agents/${NAME}`)
    .set('Authorization', bearer(user))
    .send({ config: { runtime: { webhookUrl: 'https://example.com/hook' } } });
  const seedRoom = (member) => Pod.create({ name: 'DM', type: 'agent-room', createdBy: member._id, members: [member._id] });
  const seedRow = (installedBy, podId, overrides = {}) => AgentInstallation.collection.insertOne({
    agentName: NAME, instanceId: 'default', podId, installedBy, version: '1.0.0', status: 'active', createdAt: new Date(),
    config: { runtime: { runtimeType: 'webhook', host: 'byo' } }, ...overrides,
  });
  const seedRegistry = (publisher) => AgentRegistry.collection.insertOne({
    agentName: NAME, displayName: NAME, description: 'x', registry: 'private', ephemeral: true,
    latestVersion: '1.0.0', versions: [], publisher: { userId: publisher, name: 'p' },
    manifest: { name: NAME, version: '1.0.0', runtime: { type: 'standalone' } },
  });
  /** A pod the guest can reach the agent from, as /room requires. */
  const shareAgentWith = async (user) => {
    await Pod.updateOne({ _id: home._id }, { $addToSet: { members: user._id } });
  };

  beforeAll(async () => {
    ['JWT_SECRET', 'PG_HOST'].forEach((key) => { saved[key] = process.env[key]; });
    delete process.env.PG_HOST;
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);
    app.use('/api/credentials', credentialRoutes);
    app.use('/api/agent-binding', agentBindingRoutes);
  });

  afterAll(async () => {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await closeMongoDb();
  });

  beforeEach(async () => {
    seq += 1;
    NAME = `room-rows-agent-${seq}`;
    await Promise.all([
      AgentInstallation.deleteMany({}), AgentRegistry.deleteMany({}), Pod.deleteMany({}),
      User.deleteMany({}), AgentCredential.deleteMany({}),
    ]);
    owner = await person();
    guest = await person();
    third = await person();
    home = await pod('Home', [owner._id]);
  });

  describe('a guest opens a DM with an owner\'s connected agent', () => {
    beforeEach(async () => {
      expect((await installOwner()).status).toBe(200);
      await shareAgentWith(guest);
    });

    it('the row names the guest, and the owner stays the sole installer', async () => {
      const roomId = await openDm(guest);
      const row = await AgentInstallation.findOne({ agentName: NAME, podId: roomId }).lean();
      expect(String(row.installedBy)).toBe(String(guest._id));
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });

    it('the owner can still mint the agent\'s token', async () => {
      await openDm(guest);
      const res = await mint(owner, home._id);
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^cm_agent_/);
    });

    it('the owner can still point the agent at a webhook', async () => {
      await openDm(guest);
      expect((await setWebhook(owner, home._id)).status).toBe(200);
    });

    it('the owner can still install it elsewhere with a webhook', async () => {
      await openDm(guest);
      expect(await willSolelyInstallRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });

    it('Settings shows the owner the agent\'s placement', async () => {
      await openDm(guest);
      const res = await request(app).get('/api/agent-binding/placement').set('Authorization', bearer(owner))
        .query({ agentName: NAME, instanceId: 'default' });
      expect(res.status).toBe(200);
      expect(await describeRuntimeIdentityBlockers(owner._id, NAME, 'default')).toEqual([]);
    });

    it('the guest does not become an installer', async () => {
      const roomId = await openDm(guest);
      expect(await ownsRuntimeIdentity(guest._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'owner_installation_missing' });
      const res = await mint(guest, roomId);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('owner_installation_missing');
      expect((await setWebhook(guest, roomId)).body.code).toBe('owner_installation_missing');
    });

    it('a second person who really installed it still counts', async () => {
      await openDm(guest);
      const theirs = await pod('Theirs', [third._id]);
      await seedRow(third._id, theirs._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'another_installer' });
    });

    it('a token on the room row still counts as the identity holding one', async () => {
      const roomId = await openDm(guest);
      await AgentInstallation.updateOne({ agentName: NAME, podId: roomId }, {
        $set: { runtimeTokens: [{ tokenHash: 'room-hash', label: 'old', createdAt: new Date() }] },
      });
      expect(await identityHoldsRuntimeToken(NAME, 'default')).toBe(true);
    });
  });

  describe('an agent whose only rows are agent-rooms', () => {
    let ownerRoom; let guestRoom;

    beforeEach(async () => {
      ownerRoom = await seedRoom(owner);
      guestRoom = await seedRoom(guest);
    });

    it('its publisher owns it, through their own DM with it', async () => {
      await seedRegistry(owner._id);
      await seedRow(owner._id, ownerRoom._id);
      await seedRow(guest._id, guestRoom._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });

    it('the owner on the bot\'s record owns it the same way', async () => {
      await User.collection.insertOne({
        username: NAME, email: `${NAME}@agents.test`, isBot: true, botMetadata: { ownerUserId: String(owner._id) },
      });
      await seedRow(owner._id, ownerRoom._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });

    it('its publisher can mint from their own DM', async () => {
      await seedRegistry(owner._id);
      await seedRow(owner._id, ownerRoom._id);
      await seedRow(guest._id, guestRoom._id);
      const res = await mint(owner, ownerRoom._id);
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^cm_agent_/);
    });

    it('a guest who is the only row left does not own it', async () => {
      await seedRegistry(owner._id);
      await seedRow(guest._id, guestRoom._id);
      expect(await ownsRuntimeIdentity(guest._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'owner_installation_missing' });
    });

    it('a publisher with no DM of their own has no installation to stand on', async () => {
      await seedRegistry(owner._id);
      await seedRow(guest._id, guestRoom._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'owner_installation_missing' });
    });

    it('anyone else\'s DM still stops a third person setting a webhook at install', async () => {
      await seedRegistry(owner._id);
      await seedRow(owner._id, ownerRoom._id);
      expect(await willSolelyInstallRuntimeIdentity(third._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'another_installer' });
    });

    it('the publisher can install it with a webhook past a guest\'s DM', async () => {
      await seedRegistry(owner._id);
      await seedRow(guest._id, guestRoom._id);
      expect(await willSolelyInstallRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });
  });

  describe('the rows beside a room', () => {
    it('a legacy key is recorded under the owner when a guest\'s DM row is read first', async () => {
      const room = await seedRoom(guest);
      const later = await pod('Later', [owner._id]);
      await seedRow(guest._id, room._id);
      await seedRow(owner._id, later._id, { runtimeTokens: [{ tokenHash: 'legacy-hash', label: 'old', createdAt: new Date() }] });
      await User.collection.insertOne({
        username: NAME, email: `${NAME}@agents.test`, isBot: true, botMetadata: { agentName: NAME, instanceId: 'default' },
      });
      const res = await request(app).get('/api/credentials').set('Authorization', bearer(owner))
        .query({ agentName: NAME, instanceId: 'default' });
      expect(res.status).toBe(200);
      const credential = await AgentCredential.findOne({ tokenHash: 'legacy-hash' }).lean();
      expect(String(credential.ownerUserId)).toBe(String(owner._id));
    });

    it('a hosted room row, which names the owner, changes nothing', async () => {
      await seedRow(owner._id, home._id, { config: { runtime: { runtimeType: 'native', host: 'hosted' } } });
      const room = await seedRoom(guest);
      await seedRow(owner._id, room._id, {
        config: { runtime: { runtimeType: 'native', host: 'hosted' }, autoJoinSource: 'agent-room-create' },
      });
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });

    it('an agent-dm row is still no installation, for the publisher too', async () => {
      await seedRegistry(owner._id);
      const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: owner._id, members: [owner._id] });
      await seedRow(owner._id, dm._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'owner_installation_missing' });
    });

    it('an agent-admin row is still an installation: it is not a one-to-one DM', async () => {
      await seedRow(owner._id, home._id);
      const admin = await Pod.create({ name: 'Admin', type: 'agent-admin', createdBy: third._id, members: [third._id] });
      await seedRow(third._id, admin._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default'))
        .toEqual({ owned: false, failure: 'another_installer' });
    });

    it('a room row with no recorded installer does not block the owner', async () => {
      await seedRow(owner._id, home._id);
      const room = await seedRoom(guest);
      await seedRow(undefined, room._id);
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });
  });
});
