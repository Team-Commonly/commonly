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
const AgentMemory = require('../../models/AgentMemory');
const AgentProfile = require('../../models/AgentProfile');
const Integration = require('../../models/Integration');
const RoomGrant = require('../../models/RoomGrant');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { buildAgentProfileId } = require('../../routes/registry/helpers');
const outsiderGrantAgentJoinPolicy = require('../../services/outsiderGrantAgentJoinPolicy');
const { retireHostedRoomRows } = require('../../services/hostedRuntimeService');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const {
  describeRuntimeIdentityBlockers, identityHoldsRuntimeToken, ownsRuntimeIdentity, willSolelyInstallRuntimeIdentity,
} = require('../../services/runtimeIdentityOwnership');
const AgentIdentityService = require('../../services/agentIdentityService');
const DMService = require('../../services/dmService');
const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');
const credentialRoutes = require('../../routes/credentials');
const agentBindingRoutes = require('../../routes/agentBinding');
const agentMemoryRoutes = require('../../routes/agentMemoryView');

const { hash } = require('../../utils/secret');
const socketConfig = require('../../config/socket');

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
    app.use('/api/agent-memory', agentMemoryRoutes);
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
      User.deleteMany({}), AgentCredential.deleteMany({}), AgentMemory.deleteMany({}), AgentProfile.deleteMany({}),
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

  describe('pausing an agent', () => {
    const setStatus = (user, podId, status) => request(app).patch(`/api/registry/pods/${podId}/agents/${NAME}`)
      .set('Authorization', bearer(user)).send({ status });
    const statusIn = async (podId) => (await AgentInstallation.findOne({ agentName: NAME, podId }).lean()).status;

    beforeEach(async () => {
      expect((await installOwner()).status).toBe(200);
      await shareAgentWith(guest);
    });

    it('reaches a guest\'s DM, and resuming brings it back', async () => {
      const roomId = await openDm(guest);

      expect((await setStatus(owner, home._id, 'paused')).status).toBe(200);
      expect(await statusIn(roomId)).toBe('paused');

      expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      expect(await statusIn(roomId)).toBe('active');
    });

    it('takes the guest\'s room profile with it', async () => {
      const roomId = await openDm(guest);
      await AgentProfile.updateOne(
        { agentId: buildAgentProfileId(NAME, 'default'), podId: roomId },
        { $set: { name: NAME, purpose: 'x', instructions: 'x', status: 'active' } },
        { upsert: true },
      );

      expect((await setStatus(owner, home._id, 'paused')).status).toBe(200);
      const profile = await AgentProfile.findOne({ agentId: buildAgentProfileId(NAME, 'default'), podId: roomId }).lean();
      expect(profile.status).toBe('paused');
    });

    it('leaves a row in any other state alone', async () => {
      const roomId = await openDm(guest);
      await AgentInstallation.updateOne({ agentName: NAME, podId: roomId }, { $set: { status: 'stale' } });

      expect((await setStatus(owner, home._id, 'paused')).status).toBe(200);
      expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      expect(await statusIn(roomId)).toBe('stale');
    });

    it('a guest pausing their own DM moves only that row', async () => {
      const roomId = await openDm(guest);
      const otherRoom = await openDm(owner);

      expect((await setStatus(guest, roomId, 'paused')).status).toBe(200);
      expect(await statusIn(roomId)).toBe('paused');
      expect(await statusIn(otherRoom)).toBe('active');
      expect(await statusIn(home._id)).toBe('active');
    });

    it('an installer who isn\'t the only one leaves the DM rows alone', async () => {
      const roomId = await openDm(guest);
      const other = await pod('Other', [third._id]);
      await seedRow(third._id, other._id);

      expect((await setStatus(owner, home._id, 'paused')).status).toBe(200);
      expect(await statusIn(home._id)).toBe('paused');
      expect(await statusIn(roomId)).toBe('active');
    });

    it('resuming leaves a DM a grant now keeps the agent out of', async () => {
      const roomId = await openDm(guest);
      await setStatus(owner, home._id, 'paused');
      const refuseRoom = jest.spyOn(outsiderGrantAgentJoinPolicy, 'assertAgentRuntimeMayJoinPod')
        .mockImplementation(async (podId) => {
          if (String(podId) === String(roomId)) {
            throw Object.assign(new Error('refused'), { code: 'outsider_grant_non_native_agent_join' });
          }
        });
      try {
        expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      } finally {
        refuseRoom.mockRestore();
      }
      expect(await statusIn(home._id)).toBe('active');
      expect(await statusIn(roomId)).toBe('paused');
    });

    it('resuming leaves a DM with a stored outsider-writable grant paused', async () => {
      const roomId = await openDm(guest);
      await setStatus(owner, home._id, 'paused');
      await Integration.collection.insertOne({ type: 'github-app', installationId: 'room-install', podId: roomId });
      await RoomGrant.create({
        grantId: 'grant_room_rows',
        connectionId: 'room-install',
        installationId: 'room-install',
        brokerId: GRANT_BROKER_ID,
        target: { kind: 'pod', id: String(roomId) },
        tools: ['github.list_issues'],
        writeMode: 'read',
        audience: [String(guest._id)],
        ownerId: String(guest._id),
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
      });

      expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      expect(await statusIn(home._id)).toBe('active');
      expect(await statusIn(roomId)).toBe('paused');
    });

    it('reaches a default-instance DM row stored with no instance id', async () => {
      const roomId = await openDm(guest);
      await AgentInstallation.collection.updateOne({ agentName: NAME, podId: roomId }, { $unset: { instanceId: 1 } });

      expect((await setStatus(owner, home._id, 'paused')).status).toBe(200);
      expect(await statusIn(roomId)).toBe('paused');
    });

    it('a row retired while the resume runs stays retired', async () => {
      const roomId = await openDm(guest);
      await setStatus(owner, home._id, 'paused');
      const retireRoom = jest.spyOn(outsiderGrantAgentJoinPolicy, 'assertAgentRuntimeMayJoinPod')
        .mockImplementation(async (podId) => {
          if (String(podId) !== String(roomId)) return;
          await AgentInstallation.updateOne({ agentName: NAME, podId: roomId }, { $set: { status: 'uninstalled' } });
        });
      try {
        expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      } finally {
        retireRoom.mockRestore();
      }
      expect(await statusIn(roomId)).toBe('uninstalled');
    });

    it('a retry catches up a profile the first write missed', async () => {
      const roomId = await openDm(guest);
      const profileId = buildAgentProfileId(NAME, 'default');
      await AgentProfile.updateOne(
        { agentId: profileId, podId: roomId },
        { $set: { agentId: profileId, podId: roomId, name: 'x', purpose: 'x', instructions: 'x', status: 'active' } },
        { upsert: true },
      );
      await AgentInstallation.updateOne({ agentName: NAME, podId: roomId }, { $set: { status: 'paused' } });

      expect((await setStatus(owner, home._id, 'paused')).status).toBe(200);
      expect((await AgentProfile.findOne({ agentId: profileId, podId: roomId }).lean()).status).toBe('paused');
    });

    it('a DM another agent opens while this one is paused starts paused, and comes back with its runtime', async () => {
      await AgentInstallation.updateOne({ agentName: NAME, podId: home._id }, { $set: {
        'config.runtime': { runtimeType: 'moltbot' },
      } });
      await setStatus(owner, home._id, 'paused');

      const agent = await User.findOne({ username: AgentIdentityService.buildAgentUsername(NAME, 'default'), isBot: true });
      const room = await DMService.getOrCreateAgentRoom(agent._id, guest._id, { agentName: NAME, instanceId: 'default' });
      const roomId = room._id;
      expect(await statusIn(roomId)).toBe('paused');

      expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      const row = await AgentInstallation.findOne({ agentName: NAME, podId: roomId }).lean();
      expect(row.status).toBe('active');
      expect(row.config.runtime.runtimeType).toBe('moltbot');
    });

    it('a paused agent removed from its last pod ends the DM, and reinstalling brings it back', async () => {
      const roomId = await openDm(guest);
      await User.updateOne(
        { username: AgentIdentityService.buildAgentUsername(NAME, 'default'), isBot: true },
        { $set: { 'botMetadata.ownerUserId': owner._id } },
      );
      await setStatus(owner, home._id, 'paused');

      const removed = await request(app).delete(`/api/registry/agents/${NAME}/pods/${home._id}`)
        .set('Authorization', bearer(owner));
      expect(removed.status).toBe(200);
      expect(await statusIn(roomId)).toBe('uninstalled');

      expect((await installOwner()).status).toBe(200);
      expect(await statusIn(roomId)).toBe('active');
    });

    it('a hosted agent\'s paused room rows end with it too', async () => {
      const room = await seedRoom(owner);
      const { insertedId } = await seedRow(owner._id, room._id, {
        status: 'paused', config: { runtime: { runtimeType: 'hosted' }, autoJoinSource: 'agent-room-create' },
      });
      await AgentInstallation.updateOne({ agentName: NAME, podId: home._id }, { $set: { status: 'uninstalled' } });

      expect(await retireHostedRoomRows(NAME, 'default', owner._id)).toBe(1);
      expect((await AgentInstallation.findById(insertedId).lean()).status).toBe('uninstalled');
    });

    it('resuming doesn\'t start an in-process DM row on an identity holding a token', async () => {
      const roomId = await openDm(guest);
      await AgentInstallation.updateOne({ agentName: NAME, podId: roomId }, { $set: {
        status: 'paused', 'config.runtime': { runtimeType: 'native' },
      } });
      await setStatus(owner, home._id, 'paused');
      await AgentInstallation.updateOne({ agentName: NAME, podId: home._id }, { $push: {
        runtimeTokens: { tokenHash: 'held', label: 'held', createdAt: new Date() },
      } });

      expect((await setStatus(owner, home._id, 'active')).status).toBe(200);
      expect(await statusIn(roomId)).toBe('paused');
    });
  });

  describe('the memory view', () => {
    const readMemory = (user) => request(app).get(`/api/agent-memory/${NAME}/default/editable`)
      .set('Authorization', bearer(user));
    const readIndex = (user) => request(app).get(`/api/agent-memory/${NAME}/default`)
      .set('Authorization', bearer(user));

    beforeEach(async () => {
      await AgentMemory.create({
        agentName: NAME, instanceId: 'default', content: 'private note',
        sections: { long_term: { content: 'private note', visibility: 'private', byteSize: 12 } },
      });
    });

    it('a guest\'s DM row leaves the owner their view', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(guest._id, (await seedRoom(guest))._id);
      const res = await readMemory(owner);
      expect(res.status).toBe(200);
      expect(res.body.sections.long_term.content).toBe('private note');
    });

    it('a paused DM row of a guest leaves the owner their view too', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(guest._id, (await seedRoom(guest))._id, { status: 'paused' });
      expect((await readMemory(owner)).status).toBe(200);
    });

    it('the owner\'s index lists their own pods and DM, and not a guest\'s DM', async () => {
      const mine = await seedRoom(owner);
      const theirs = await seedRoom(guest);
      await seedRow(owner._id, home._id);
      await seedRow(owner._id, mine._id);
      await seedRow(guest._id, theirs._id);
      const res = await readIndex(owner);
      expect(res.status).toBe(200);
      expect(res.body.pods.map((entry) => entry.id).sort()).toEqual([String(home._id), String(mine._id)].sort());
    });

    it('the owner\'s index leaves out an agent-dm they can\'t see', async () => {
      const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: third._id, members: [third._id] });
      await seedRow(owner._id, home._id);
      await seedRow(third._id, dm._id);
      const res = await readIndex(owner);
      expect(res.body.pods.map((entry) => entry.id)).toEqual([String(home._id)]);
    });

    it('the owner\'s index still lists a pod they have since left', async () => {
      const left = await pod('Left', [third._id]);
      await seedRow(owner._id, home._id);
      await seedRow(owner._id, left._id);
      const res = await readIndex(owner);
      expect(res.body.pods.map((entry) => entry.id).sort()).toEqual([String(home._id), String(left._id)].sort());
    });

    it('an admin\'s index still lists every pod', async () => {
      const admin = await User.create({ username: `mem-admin-${seq}`, email: `mem-admin-${seq}@test.invalid`, password: 'password123', role: 'admin' });
      const room = await seedRoom(guest);
      await seedRow(owner._id, home._id);
      await seedRow(guest._id, room._id);
      const res = await readIndex(admin);
      expect(res.body.viewerRole).toBe('admin');
      expect(res.body.pods.map((entry) => entry.id).sort()).toEqual([String(home._id), String(room._id)].sort());
    });

    it('a guest whose DM row is the only row is refused', async () => {
      await seedRow(guest._id, (await seedRoom(guest))._id);
      const res = await readMemory(guest);
      expect(res.status).toBe(403);
      expect(res.body.sections).toBeUndefined();
    });

    it('a guest is refused the index as well, so they get no owner role', async () => {
      await seedRow(guest._id, (await seedRoom(guest))._id);
      const res = await readIndex(guest);
      expect(res.status).toBe(403);
      expect(res.body.viewerRole).toBeUndefined();
    });

    it('a guest beside the owner\'s install is refused', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(guest._id, (await seedRoom(guest))._id);
      expect((await readMemory(guest)).status).toBe(403);
    });

    it('with rooms left, the publisher reads through their own DM and a guest does not', async () => {
      await seedRegistry(owner._id);
      await seedRow(owner._id, (await seedRoom(owner))._id);
      await seedRow(guest._id, (await seedRoom(guest))._id);
      expect((await readMemory(owner)).status).toBe(200);
      expect((await readMemory(guest)).status).toBe(403);
    });

    it('a publisher with no DM of their own has nothing to stand on', async () => {
      await seedRegistry(owner._id);
      await seedRow(guest._id, (await seedRoom(guest))._id);
      expect((await readMemory(owner)).status).toBe(403);
    });

    it('someone else\'s paused install still refuses an installer', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id, { status: 'paused' });
      expect((await readMemory(owner)).status).toBe(403);
    });

    it('that paused install stays out of the token rule, which reads active rows', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id, { status: 'paused' });
      expect(await ownsRuntimeIdentity(owner._id, NAME, 'default')).toEqual({ owned: true });
    });


    it('a paused install of one\'s own does not reach another installer\'s active agent', async () => {
      await seedRow(owner._id, home._id, { status: 'paused' });
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id);
      expect((await readMemory(owner)).status).toBe(403);
    });

    it('a sole installer whose only row is paused keeps their view', async () => {
      await seedRow(owner._id, home._id, { status: 'paused' });
      expect((await readMemory(owner)).status).toBe(200);
    });

    it('someone else\'s uninstalled row refuses no one', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id, { status: 'uninstalled' });
      expect((await readMemory(owner)).status).toBe(200);
    });

    it('an agent-admin row still counts against the owner', async () => {
      await seedRow(owner._id, home._id);
      const admin = await Pod.create({ name: 'Admin', type: 'agent-admin', createdBy: third._id, members: [third._id] });
      await seedRow(third._id, admin._id);
      expect((await readMemory(owner)).status).toBe(403);
    });

    it('an agent-dm row counts for and against no one', async () => {
      const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: third._id, members: [third._id] });
      await seedRow(owner._id, home._id);
      await seedRow(third._id, dm._id);
      expect((await readMemory(owner)).status).toBe(200);
      expect((await readMemory(third)).status).toBe(403);
    });

    it('a pod row with no recorded installer still refuses the owner', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(undefined, (await pod('Old', [third._id]))._id);
      expect((await readMemory(owner)).status).toBe(403);
    });

    it('a row with a mixed-case instance id still counts', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id, { instanceId: 'Default' });
      expect((await readMemory(owner)).status).toBe(403);
    });
  });

  describe('renaming an agent', () => {
    const rename = (user, podId) => request(app).patch(`/api/registry/pods/${podId}/agents/${NAME}`)
      .set('Authorization', bearer(user)).send({ displayName: 'Renamed' });
    const botName = () => User.findOne({ 'botMetadata.agentName': NAME }).lean()
      .then((bot) => bot?.botMetadata?.displayName);

    beforeEach(async () => {
      await User.create({
        username: AgentIdentityService.buildAgentUsername(NAME, 'default'), email: `${NAME}@agents.test`,
        password: 'password123', isBot: true, botType: 'agent',
        botMetadata: { agentName: NAME, instanceId: 'default', displayName: 'Before' },
      });
    });

    it('a guest\'s DM row doesn\'t stop the owner', async () => {
      await seedRow(owner._id, home._id, { displayName: 'Before' });
      await seedRow(guest._id, (await seedRoom(guest))._id, { displayName: 'Before' });
      const res = await rename(owner, home._id);
      expect(res.status).toBe(200);
      expect(await botName()).toBe('Renamed');
    });

    it('a paused DM row of a guest doesn\'t stop the owner either', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(guest._id, (await seedRoom(guest))._id, { status: 'paused' });
      expect((await rename(owner, home._id)).status).toBe(200);
    });

    it('an agent-dm row doesn\'t stop the owner', async () => {
      await seedRow(owner._id, home._id);
      const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: third._id, members: [third._id] });
      await seedRow(third._id, dm._id);
      expect((await rename(owner, home._id)).status).toBe(200);
    });

    it('with rooms left, the publisher renames from their own DM', async () => {
      await seedRegistry(owner._id);
      const room = await seedRoom(owner);
      await seedRow(owner._id, room._id);
      await seedRow(guest._id, (await seedRoom(guest))._id);
      expect((await rename(owner, room._id)).status).toBe(200);
    });

    it('a guest whose DM row is the only row is refused', async () => {
      const room = await seedRoom(guest);
      await seedRow(guest._id, room._id);
      const res = await rename(guest, room._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('owner_installation_missing');
      expect(await botName()).toBe('Before');
    });

    it('a guest beside the owner\'s install is refused as before', async () => {
      await seedRow(owner._id, home._id);
      const room = await seedRoom(guest);
      await seedRow(guest._id, room._id);
      const res = await rename(guest, room._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('another_installer');
    });

    it('someone else\'s paused install still refuses an installer', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id, { status: 'paused' });
      const res = await rename(owner, home._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('another_installer');
    });

    it('a sole installer whose only row is paused can still rename', async () => {
      await seedRow(owner._id, home._id, { status: 'paused' });
      expect((await rename(owner, home._id)).status).toBe(200);
    });

    it('a pod row with no recorded installer reads unknown_installer, ahead of another installer', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(third._id, (await pod('Theirs', [third._id]))._id);
      await seedRow(undefined, (await pod('Old', [third._id]))._id);
      const res = await rename(owner, home._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('unknown_installer');
    });

    it('an agent-admin row still counts', async () => {
      await seedRow(owner._id, home._id);
      const admin = await Pod.create({ name: 'Admin', type: 'agent-admin', createdBy: third._id, members: [third._id] });
      await seedRow(third._id, admin._id);
      expect((await rename(owner, home._id)).body.code).toBe('another_installer');
    });

    describe('the label on DM rows', () => {
      const labelOf = async (podId, extra = {}) => (
        await AgentInstallation.findOne({ agentName: NAME, podId, ...extra }).lean()
      ).displayName;
      const before = { displayName: 'Before' };

      it('a guest\'s DM row takes the new name', async () => {
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(guest._id, room._id, before);
        expect((await rename(owner, home._id)).status).toBe(200);
        expect(await labelOf(room._id)).toBe('Renamed');
        const row = await AgentInstallation.findOne({ agentName: NAME, podId: room._id }).lean();
        expect(String(row.installedBy)).toBe(String(guest._id));
      });

      it('the agent posts under the new name in the guest\'s DM', async () => {
        const RAW = `cm_agent_${NAME}`;
        await User.updateOne({ 'botMetadata.agentName': NAME }, {
          $set: { agentRuntimeTokens: [{ tokenHash: hash(RAW), label: 'test', createdAt: new Date() }] },
        });
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(guest._id, room._id, before);
        const bot = await User.findOne({ 'botMetadata.agentName': NAME }).select('_id').lean();
        await Pod.updateOne({ _id: room._id }, { $addToSet: { members: bot._id } });
        expect((await rename(owner, home._id)).status).toBe(200);
        const emit = jest.fn();
        const live = jest.spyOn(socketConfig, 'getIO').mockReturnValue({ to: () => ({ emit }) });
        try {
          const posted = await request(app).post(`/api/agents/runtime/pods/${room._id}/messages`)
            .set('Authorization', `Bearer ${RAW}`).send({ content: 'hello there' });
          expect(posted.status).toBe(200);
        } finally {
          live.mockRestore();
        }
        const [, message] = emit.mock.calls.find(([event]) => event === 'newMessage');
        expect(message.username).toBe('Renamed');
      });

      it('an agent-dm row, a paused one, and a stopped one that can come back all take it', async () => {
        const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: third._id, members: [third._id] });
        const paused = await seedRoom(guest);
        const stopped = await seedRoom(third);
        await seedRow(owner._id, home._id, before);
        await seedRow(third._id, dm._id, before);
        await seedRow(guest._id, paused._id, { ...before, status: 'paused' });
        await seedRow(third._id, stopped._id, { ...before, status: 'uninstalled' });
        expect((await rename(owner, home._id)).status).toBe(200);
        expect([await labelOf(dm._id), await labelOf(paused._id), await labelOf(stopped._id)])
          .toEqual(['Renamed', 'Renamed', 'Renamed']);
      });

      it('a legacy mixed-case DM row takes it', async () => {
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(guest._id, room._id, { ...before, instanceId: 'Default' });
        expect((await rename(owner, home._id)).status).toBe(200);
        expect(await labelOf(room._id)).toBe('Renamed');
      });

      it('the DM\'s agent profile takes it', async () => {
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(guest._id, room._id, before);
        await AgentProfile.create({
          agentId: `${NAME}:default`, agentName: NAME, instanceId: 'default', podId: room._id,
          name: 'Before', purpose: 'Test', createdBy: guest._id,
        });
        expect((await rename(owner, home._id)).status).toBe(200);
        expect((await AgentProfile.findOne({ podId: room._id }).lean()).name).toBe('Renamed');
      });

      it('another identity\'s rows keep their names, in the same DM and in another instance', async () => {
        const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: third._id, members: [third._id] });
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(third._id, dm._id, before);
        await seedRow(third._id, dm._id, { ...before, agentName: `${NAME}-other` });
        await seedRow(guest._id, room._id, { ...before, instanceId: 'nova' });
        await AgentProfile.create({
          agentId: `${NAME}-other:default`, agentName: `${NAME}-other`, instanceId: 'default', podId: dm._id,
          name: 'Other', purpose: 'Test', createdBy: third._id,
        });
        expect((await rename(owner, home._id)).status).toBe(200);
        expect(await labelOf(dm._id)).toBe('Renamed');
        const other = await AgentInstallation.findOne({ agentName: `${NAME}-other` }).lean();
        expect(other.displayName).toBe('Before');
        expect(await labelOf(room._id, { instanceId: 'nova' })).toBe('Before');
        expect((await AgentProfile.findOne({ agentName: `${NAME}-other` }).lean()).name).toBe('Other');
      });

      it('an uninstalled pod row keeps its name: only DM rows are written past the caller\'s own', async () => {
        const gone = await pod('Gone', [third._id]);
        await seedRow(owner._id, home._id, before);
        await seedRow(third._id, gone._id, { ...before, status: 'uninstalled' });
        expect((await rename(owner, home._id)).status).toBe(200);
        expect(await labelOf(gone._id)).toBe('Before');
      });

      it('a refused rename leaves DM rows alone', async () => {
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(guest._id, room._id, before);
        await seedRow(third._id, (await pod('Theirs', [third._id]))._id, before);
        expect((await rename(owner, home._id)).status).toBe(403);
        expect(await labelOf(room._id)).toBe('Before');
      });

      it('an incomplete rename leaves DM rows alone', async () => {
        const room = await seedRoom(guest);
        await seedRow(owner._id, home._id, before);
        await seedRow(owner._id, (await pod('Left', [third._id]))._id, before);
        await seedRow(guest._id, room._id, before);
        expect((await rename(owner, home._id)).status).toBe(409);
        expect(await labelOf(room._id)).toBe('Before');
      });

      it('a name another agent shows in that DM is refused, and nothing moves', async () => {
        const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: third._id, members: [third._id] });
        await seedRow(owner._id, home._id, before);
        await seedRow(third._id, dm._id, before);
        await seedRow(third._id, dm._id, { agentName: `${NAME}-other`, displayName: 'Renamed' });
        const res = await rename(owner, home._id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('agent_display_name_taken');
        expect(await labelOf(dm._id)).toBe('Before');
      });
    });

    it('a sole installer\'s row in a pod they can\'t reach still leaves the rename incomplete', async () => {
      await seedRow(owner._id, home._id);
      await seedRow(owner._id, (await pod('Left', [third._id]))._id);
      const res = await rename(owner, home._id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('identity_rename_scope_incomplete');
    });
  });

  describe('legacy keys found while an admin lists credentials', () => {
    let admin;
    const listAsAdmin = () => request(app).get('/api/credentials').set('Authorization', bearer(admin))
      .query({ agentName: NAME, instanceId: 'default' });
    const legacyKey = { runtimeTokens: [{ tokenHash: 'admin-hash', label: 'old', createdAt: new Date() }] };
    const recordedOwner = async () => {
      const credential = await AgentCredential.findOne({ tokenHash: 'admin-hash' }).lean();
      return String(credential.ownerUserId);
    };

    beforeEach(async () => {
      admin = await User.create({ username: `admin-${seq}`, email: `admin-${seq}@test.invalid`, password: 'password123', role: 'admin' });
      await User.collection.insertOne({
        username: NAME, email: `${NAME}@agents.test`, isBot: true, botMetadata: { agentName: NAME, instanceId: 'default' },
      });
    });

    it('go to the pod row\'s installer when a guest\'s DM row is read first', async () => {
      await seedRow(guest._id, (await seedRoom(guest))._id);
      await seedRow(owner._id, (await pod('Later', [owner._id]))._id, legacyKey);
      expect((await listAsAdmin()).status).toBe(200);
      expect(await recordedOwner()).toBe(String(owner._id));
      const guestRows = await request(app).get('/api/credentials').set('Authorization', bearer(guest));
      expect(guestRows.body).toEqual([]);
    });

    it('go to the pod row\'s installer when an agent-dm row is read first', async () => {
      const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: guest._id, members: [guest._id] });
      await seedRow(guest._id, dm._id);
      await seedRow(owner._id, (await pod('Later', [owner._id]))._id, legacyKey);
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(owner._id));
    });

    it('go to a paused pod row\'s installer', async () => {
      await seedRow(guest._id, (await seedRoom(guest))._id);
      await seedRow(owner._id, (await pod('Later', [owner._id]))._id, { status: 'paused', ...legacyKey });
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(owner._id));
    });

    it('go to the admin when only DM rows are left', async () => {
      await seedRow(guest._id, (await seedRoom(guest))._id, legacyKey);
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(admin._id));
    });

    it('go to the admin when the pod row has no recorded installer', async () => {
      await seedRow(undefined, home._id, legacyKey);
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(admin._id));
    });

    it('pass over a pod row with no recorded installer for one that has one', async () => {
      await seedRow(undefined, (await pod('Old', [third._id]))._id);
      await seedRow(owner._id, (await pod('Later', [owner._id]))._id, legacyKey);
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(owner._id));
    });

    it('go to the admin when the only pod row is uninstalled', async () => {
      await seedRow(guest._id, (await pod('Gone', [guest._id]))._id, { status: 'uninstalled', ...legacyKey });
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(admin._id));
    });

    it('skip an uninstalled pod row', async () => {
      await seedRow(guest._id, (await pod('Gone', [guest._id]))._id, { status: 'uninstalled' });
      await seedRow(owner._id, (await pod('Later', [owner._id]))._id, legacyKey);
      await listAsAdmin();
      expect(await recordedOwner()).toBe(String(owner._id));
    });
  });
});
