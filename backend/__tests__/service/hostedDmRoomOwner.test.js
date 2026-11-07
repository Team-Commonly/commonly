// Only an agent's owner counts it against a cap, holds it, and can start, stop
// or read owner-only state. A person in a DM with someone else's hosted agent
// is a guest, and the DM keeps working: the agent answers there and the turn
// goes on the owner's line. Real mongod, because every claim here is about which
// rows a query reaches.
const http = require('http');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

jest.mock('../../models/pg/Message', () => ({
  findByPodId: jest.fn().mockResolvedValue([]),
  deleteByPodId: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));
jest.mock('../../services/installable/eventHandlers', () => ({ dispatch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/starterTaskService', () => ({
  ...jest.requireActual('../../services/starterTaskService'),
  completeFirstTaskOnAnswer: jest.fn(),
  completeConnectAgentStarterTask: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/agentComputerBroker', () => ({ agentComputerBroker: {}, agentComputerEnabled: false }));

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentRun = require('../../models/AgentRun');
const Message = require('../../models/Message');
const { AgentInstallation } = require('../../models/AgentRegistry');
const DMService = require('../../services/dmService');
const hostedRuntime = require('../../services/hostedRuntimeService');
const { runAgent } = require('../../services/nativeRuntimeService');
const { deletePodCascade } = require('../../services/podDeletionService');
const hostedRouter = require('../../routes/hosted');
const agentsRuntimeRouter = require('../../routes/agentsRuntime');
const registryRouter = require('../../routes/registry');
const { reassignHostedRoomOwners } = require('../../scripts/reassign-hosted-room-owners');

const SECRET = 'hosted-dm-room-owner-test';
const NAME = 'room-agent';
const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;
const ROOM_SOURCE = 'agent-room-create';

const hostedConfig = (extra = {}) => ({
  runtime: { runtimeType: 'hosted' },
  hosted: { engine: 'native', provisionedAt: new Date(), about: 'Keeps the log.' },
  ...extra,
});

const seedRow = (installedBy, podId, overrides = {}) => AgentInstallation.collection.insertOne({
  agentName: NAME,
  instanceId: 'default',
  podId,
  installedBy,
  version: '1.0.0',
  status: 'active',
  displayName: 'Room agent',
  config: hostedConfig(),
  ...overrides,
});

describe('a hosted agent DM', () => {
  let app; let server; let owner; let guest; let third; let admin; let bot; let workspace;
  const saved = {};
  const KEYS = ['JWT_SECRET', 'HOSTED_ENGINE', 'HOSTED_AGENTS_PER_USER', 'LITELLM_BASE_URL', 'LITELLM_MASTER_KEY',
    'HOSTED_RUNTIME_URL', 'HOSTED_RUNTIME_ADMIN_TOKEN', 'PG_HOST'];

  const pod = (name, members, type = 'chat') => Pod.create({
    name, type, createdBy: members[0], members,
  });
  const openRoom = (user, name = NAME) => DMService.getOrCreateAgentRoom(bot._id, user._id, { agentName: name, instanceId: 'default' });
  const roomRow = (room) => AgentInstallation.findOne({ podId: room._id, agentName: NAME }).lean();
  const hostedPost = (user, verb, body = { agentName: NAME }) => request(app)
    .post(`/api/hosted/${verb}`).set('Authorization', bearer(user)).send(body);
  const hostedGet = (user, path, query = {}) => request(app)
    .get(`/api/hosted/${path}`).set('Authorization', bearer(user)).query(query);
  const removeFromPod = (user, podId) => request(app)
    .delete(`/api/registry/agents/${NAME}/pods/${podId}`).set('Authorization', bearer(user));

  beforeAll(async () => {
    KEYS.forEach((key) => { saved[key] = process.env[key]; });
    delete process.env.PG_HOST;
    process.env.JWT_SECRET = SECRET;
    process.env.HOSTED_RUNTIME_URL = 'http://hosted-runtime.test';
    process.env.HOSTED_RUNTIME_ADMIN_TOKEN = 'admin-token';
    process.env.LITELLM_MASTER_KEY = 'test-only';
    await setupMongoDb();
    // A proxy-shaped model boundary, so a real run writes a real AgentRun.
    server = http.createServer(async (req, res) => {
      // eslint-disable-next-line no-unused-vars, no-empty
      for await (const _chunk of req) {}
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        model: 'deepseek-v4-flash',
        choices: [{ message: { role: 'assistant', content: 'A model answer.' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    process.env.LITELLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    app = express();
    app.use(express.json());
    app.use('/api/hosted', hostedRouter);
    app.use('/api/registry', registryRouter);
    app.use('/api/agents/runtime', agentsRuntimeRouter);
  });

  afterAll(async () => {
    KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
    await new Promise((resolve) => { server.close(resolve); });
    await closeMongoDb();
  });

  beforeEach(async () => {
    process.env.HOSTED_ENGINE = 'native';
    process.env.HOSTED_AGENTS_PER_USER = '1';
    jest.restoreAllMocks();
    await Promise.all([User.deleteMany({}), Pod.deleteMany({}), AgentInstallation.deleteMany({}),
      AgentRun.deleteMany({}), Message.deleteMany({})]);
    const person = (name, extra = {}) => User.create({ username: name, email: `${name}@test.com`, password: 'password123', ...extra });
    owner = await person('room-owner');
    guest = await person('room-guest');
    third = await person('room-third');
    admin = await person('room-admin', { role: 'admin' });
    bot = await User.create({
      username: NAME,
      email: `${NAME}@agents.commonly.local`,
      password: 'password123',
      isBot: true,
      botMetadata: { agentName: NAME, instanceId: 'default' },
    });
    workspace = await pod('Workspace', [owner._id, guest._id, bot._id]);
    await seedRow(owner._id, workspace._id);
  });

  describe('holds nothing for a guest', () => {
    it('does not count someone else\'s agent against the guest, and offers them the slot', async () => {
      await openRoom(guest);
      await expect(hostedRuntime.countHostedAgentsForUser(guest._id)).resolves.toBe(0);
      await expect(hostedRuntime.listHostedInstallationsForUser(guest._id)).resolves.toEqual([]);
      await expect(hostedRuntime.findHeldHostedInstallation(guest._id, NAME, 'default')).resolves.toBeNull();
      const availability = await hostedGet(guest, 'availability');
      expect(availability.status).toBe(200);
      expect(availability.body).toMatchObject({ held: null, full: false });
    });

    it('keeps the agent counted once for its owner, however many guests talk to it', async () => {
      await Pod.updateOne({ _id: workspace._id }, { $addToSet: { members: third._id } });
      await openRoom(guest);
      await openRoom(third);
      await expect(hostedRuntime.countHostedAgentsForUser(owner._id)).resolves.toBe(1);
    });

    it.each(['provision', 'deprovision'])('answers a guest\'s %s as not theirs, and changes nothing', async (verb) => {
      const room = await openRoom(guest);
      const before = await roomRow(room);
      const response = await hostedPost(guest, verb);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('not_owner_or_missing');
      expect(await roomRow(room)).toEqual(before);
      expect((await AgentInstallation.findOne({ podId: workspace._id }).lean()).config.hosted.provisionedAt).toBeTruthy();
    });

    it('answers the same with the instance named', async () => {
      await openRoom(guest);
      expect((await hostedPost(guest, 'deprovision', { agentName: NAME, instanceId: 'default' })).status).toBe(404);
    });

    it('never reaches the worker on a guest\'s stop, on the Durable Object engine', async () => {
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: { config: { runtime: { runtimeType: 'hosted' }, hosted: { provisionedAt: new Date() } } } });
      await openRoom(guest);
      const stop = jest.spyOn(hostedRuntime, 'deprovisionAgent').mockResolvedValue({ deprovisioned: true });
      expect((await hostedPost(guest, 'deprovision')).status).toBe(404);
      expect(stop).not.toHaveBeenCalled();
      expect((await hostedPost(owner, 'deprovision')).status).toBe(200);
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('keeps /status for the owner', async () => {
      await openRoom(guest);
      expect((await hostedGet(guest, 'status', { agentName: NAME })).status).toBe(404);
      expect((await hostedGet(owner, 'status', { agentName: NAME })).status).toBe(200);
    });

    it('keeps the installer-only registry routes from a guest', async () => {
      const room = await openRoom(guest);
      const status = await request(app)
        .get(`/api/registry/pods/${room._id}/agents/${NAME}/runtime-status`)
        .set('Authorization', bearer(guest));
      expect(status.status).toBe(403);
      const config = await request(app)
        .patch(`/api/registry/pods/${room._id}/agents/${NAME}`)
        .set('Authorization', bearer(guest))
        .send({ config: { about: 'Written by a guest.' } });
      expect(config.status).toBe(403);
    });
  });

  describe('keeps working', () => {
    it('writes an active room row that still runs in-process', async () => {
      const room = await openRoom(guest);
      const row = await roomRow(room);
      expect(row).toMatchObject({ status: 'active', instanceId: 'default' });
      expect(row.config.runtime.runtimeType).toBe('hosted');
      expect(row.config.hosted.engine).toBe('native');
      expect(row.config.autoJoinSource).toBe(ROOM_SOURCE);
      expect(String(row.installedBy)).toBe(String(owner._id));
      expect(String((await Pod.findById(room._id)).members.at(-1))).toBe(String(guest._id));
    });

    it('answers the guest, on the owner\'s line, and shows on the owner\'s meter', async () => {
      const room = await openRoom(guest);
      const installation = await roomRow(room);
      const result = await runAgent(installation, {
        type: 'chat.mention',
        payload: { content: '@room-agent hello', userId: String(guest._id), username: guest.username },
      });
      expect(result.status).toBe('succeeded');
      const runs = await AgentRun.find({ podId: room._id }).lean();
      expect(runs).toHaveLength(1);
      expect(runs[0].userId).toBe(String(owner._id));
      const status = await hostedGet(owner, 'status', { agentName: NAME });
      expect(status.body.meter.used).toBe(1);
      await expect(AgentRun.countDocuments({ userId: String(guest._id) })).resolves.toBe(0);
    });

    it('lets the owner\'s stop and start reach the guest\'s room', async () => {
      const room = await openRoom(guest);
      expect((await hostedPost(owner, 'deprovision')).status).toBe(200);
      expect((await roomRow(room)).config.hosted.provisionedAt).toBeNull();
      expect((await hostedPost(owner, 'provision')).status).toBe(200);
      expect((await roomRow(room)).config.hosted.provisionedAt).toBeTruthy();
    });
  });

  describe('finds the owner', () => {
    it('is the owner themself in their own room', async () => {
      const room = await openRoom(owner);
      expect(String((await roomRow(room)).installedBy)).toBe(String(owner._id));
    });

    it('is the person opening it when they host the agent too', async () => {
      const theirs = await pod('Theirs', [guest._id, bot._id]);
      await seedRow(guest._id, theirs._id);
      const room = await openRoom(guest);
      expect(String((await roomRow(room)).installedBy)).toBe(String(guest._id));
    });

    it('is whoever hosts it in a pod the person is in, when several people host it', async () => {
      const earlier = new mongoose.Types.ObjectId('000000000000000000000001');
      const elsewhere = await pod('Elsewhere', [third._id, bot._id]);
      await seedRow(third._id, elsewhere._id, { _id: earlier });
      const room = await openRoom(guest);
      expect(String((await roomRow(room)).installedBy)).toBe(String(owner._id));
    });

    it('never takes another guest\'s room row for an owner', async () => {
      const legacyRoom = await pod('Legacy room', [bot._id, third._id], 'agent-room');
      await seedRow(third._id, legacyRoom._id, {
        _id: new mongoose.Types.ObjectId('000000000000000000000002'),
        config: hostedConfig({ autoJoinSource: ROOM_SOURCE }),
      });
      const room = await openRoom(guest);
      expect(String((await roomRow(room)).installedBy)).toBe(String(owner._id));
      await Pod.updateOne({ _id: workspace._id }, { $addToSet: { members: third._id } });
      const reopened = await hostedRuntime.resolveHostedOwner(NAME, 'default', third._id);
      expect(String(reopened.ownerId)).toBe(String(owner._id));
    });

    it('never takes a row an agent installed for itself for an owner', async () => {
      await AgentInstallation.deleteMany({});
      await seedRow(bot._id, workspace._id, { _id: new mongoose.Types.ObjectId('000000000000000000000003') });
      await expect(hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id)).resolves.toBeNull();
    });

    it('folds case and a missing instance the way identity does', async () => {
      await AgentInstallation.collection.updateOne({ podId: workspace._id }, { $unset: { instanceId: '' } });
      expect(String((await hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id)).ownerId)).toBe(String(owner._id));
      await AgentInstallation.collection.updateOne({ podId: workspace._id }, { $set: { instanceId: 'Demo' } });
      expect(String((await hostedRuntime.resolveHostedOwner(NAME, 'demo', guest._id)).ownerId)).toBe(String(owner._id));
    });

    it('never takes an older row on another runtime for an owner', async () => {
      const elsewhere = await pod('Elsewhere', [third._id, bot._id]);
      await seedRow(third._id, elsewhere._id, {
        _id: new mongoose.Types.ObjectId('000000000000000000000004'),
        config: { runtime: { runtimeType: 'webhook' } },
      });
      await Pod.updateOne({ _id: workspace._id }, { $addToSet: { members: admin._id } });
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', admin._id);
      expect(String(found.ownerId)).toBe(String(owner._id));
    });

    it('passes over someone who removed it for someone who still hosts it', async () => {
      const elsewhere = await pod('Elsewhere', [third._id, bot._id]);
      await seedRow(third._id, elsewhere._id, { status: 'uninstalled' });
      await Pod.updateOne({ _id: workspace._id }, { $addToSet: { members: third._id } });
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', third._id);
      expect(found).toMatchObject({ live: true });
      expect(String(found.ownerId)).toBe(String(owner._id));
    });

    it('writes no row at all when nobody owns it', async () => {
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: { 'config.autoJoinSource': ROOM_SOURCE, installedBy: third._id } });
      const room = await openRoom(guest);
      await expect(roomRow(room)).resolves.toBeNull();
      await expect(hostedRuntime.countHostedAgentsForUser(guest._id)).resolves.toBe(0);
    });

    it('leaves a room with an agent on any other runtime as it was', async () => {
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: { config: { runtime: { runtimeType: 'native' } } } });
      const room = await openRoom(guest);
      expect(String((await roomRow(room)).installedBy)).toBe(String(guest._id));
    });
  });

  describe('ending it', () => {
    it('frees the owner\'s slot and ends the guest rooms with the owner\'s last row', async () => {
      const room = await openRoom(guest);
      expect((await removeFromPod(owner, workspace._id)).status).toBe(200);
      expect((await roomRow(room)).status).toBe('uninstalled');
      await expect(hostedRuntime.countHostedAgentsForUser(owner._id)).resolves.toBe(0);
      await expect(hostedRuntime.listHostedInstallationsForUser(owner._id)).resolves.toEqual([]);
    });

    it('keeps the guest rooms while the owner still has it in another room', async () => {
      const room = await openRoom(guest);
      const second = await pod('Second', [owner._id, bot._id]);
      await seedRow(owner._id, second._id);
      expect((await removeFromPod(owner, workspace._id)).status).toBe(200);
      expect((await roomRow(room)).status).toBe('active');
    });

    it('does the same on the admin removal', async () => {
      const room = await openRoom(guest);
      const { _id } = await AgentInstallation.findOne({ podId: workspace._id }).lean();
      const response = await request(app)
        .delete(`/api/registry/admin/installations/${_id}`).set('Authorization', bearer(admin));
      expect(response.status).toBe(200);
      expect((await roomRow(room)).status).toBe('uninstalled');
    });

    it('does the same when the pod is deleted', async () => {
      const room = await openRoom(guest);
      await deletePodCascade(String(workspace._id));
      expect((await roomRow(room)).status).toBe('uninstalled');
      await expect(hostedRuntime.countHostedAgentsForUser(owner._id)).resolves.toBe(0);
    });

    it('leaves other owners\' rows and other agents alone', async () => {
      const coOwned = await pod('Co-owned', [third._id, bot._id]);
      await seedRow(third._id, coOwned._id);
      const thirdsRoom = await pod('Their room', [bot._id, third._id], 'agent-room');
      await seedRow(third._id, thirdsRoom._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      const otherAgentRoom = await pod('Other agent room', [bot._id, guest._id], 'agent-room');
      await seedRow(owner._id, otherAgentRoom._id, { agentName: 'other-agent', config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      expect((await removeFromPod(owner, workspace._id)).status).toBe(200);
      expect((await roomRow(thirdsRoom)).status).toBe('active');
      expect((await AgentInstallation.findOne({ podId: otherAgentRoom._id }).lean()).status).toBe('active');
    });

    it('ends the owner\'s rooms even when someone else hosts the same agent', async () => {
      const room = await openRoom(guest);
      const coOwned = await pod('Co-owned', [third._id, bot._id]);
      await seedRow(third._id, coOwned._id);
      expect((await removeFromPod(owner, workspace._id)).status).toBe(200);
      expect((await roomRow(room)).status).toBe('uninstalled');
      expect((await AgentInstallation.findOne({ podId: coOwned._id }).lean()).status).toBe('active');
    });

    it('lets a guest end their own room, and only their own', async () => {
      const room = await openRoom(guest);
      expect((await removeFromPod(third, room._id)).status).toBe(403);
      expect((await removeFromPod(guest, room._id)).status).toBe(200);
      expect((await roomRow(room)).status).toBe('uninstalled');
      expect((await AgentInstallation.findOne({ podId: workspace._id }).lean()).status).toBe('active');
    });

    it('lets the owner end a guest\'s room they are not in', async () => {
      const room = await openRoom(guest);
      expect((await removeFromPod(owner, room._id)).status).toBe(200);
      expect((await roomRow(room)).status).toBe('uninstalled');
    });

    it('does not let an installer outside an ordinary pod remove it', async () => {
      const left = await pod('Left', [owner._id, bot._id]);
      await seedRow(third._id, left._id);
      expect((await removeFromPod(third, left._id)).status).toBe(403);
      expect((await AgentInstallation.findOne({ podId: left._id }).lean()).status).toBe('active');
    });

    it('still keeps a pod member who is not the installer from removing it from a pod', async () => {
      expect((await removeFromPod(guest, workspace._id)).status).toBe(403);
    });
  });

  describe('only charges someone who shares a pod with the person', () => {
    const id = (n) => new mongoose.Types.ObjectId(String(n).padStart(24, '0'));
    const talkTo = (user, agentName = NAME) => request(app)
      .post('/api/agents/runtime/room').set('Authorization', bearer(user)).send({ agentName, instanceId: 'default' });
    const addMember = (podId, user) => Pod.updateOne({ _id: podId }, { $addToSet: { members: user._id } });
    const rooms = () => Pod.countDocuments({ type: 'agent-room' });
    const refusal = { ownerId: null, live: true };

    it('lets the person\'s own install win over an older owner they share a pod with', async () => {
      const theirs = await pod('Theirs', [guest._id, bot._id]);
      await seedRow(guest._id, theirs._id);
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id);
      expect(String(found.ownerId)).toBe(String(guest._id));
    });

    it('lets an owner\'s own install win when they have left the pod it is in', async () => {
      await Pod.updateOne({ _id: workspace._id }, { $pull: { members: owner._id } });
      const room = await openRoom(owner);
      expect(String((await roomRow(room)).installedBy)).toBe(String(owner._id));
    });

    it('does not charge an owner who has left the pod, though their row stays in it', async () => {
      await Pod.updateOne({ _id: workspace._id }, { $pull: { members: owner._id } });
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id);
      expect(found).toMatchObject({ ownerId: null, live: true });
      await expect(openRoom(guest)).rejects.toMatchObject({ code: 'hosted_no_shared_owner' });
    });

    it('takes the oldest of the owners sharing a pod, however the rows were inserted', async () => {
      await AgentInstallation.deleteMany({});
      const late = await pod('Late', [third._id, guest._id, bot._id]);
      const early = await pod('Early', [owner._id, guest._id, bot._id]);
      const oldest = await pod('Oldest, not shared', [admin._id, bot._id]);
      await seedRow(third._id, late._id, { _id: id(30) });
      await seedRow(owner._id, early._id, { _id: id(20) });
      await seedRow(admin._id, oldest._id, { _id: id(10) });
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id);
      expect(String(found.ownerId)).toBe(String(owner._id));
    });

    it('never picks an owner who shares no pod with the person', async () => {
      await expect(hostedRuntime.resolveHostedOwner(NAME, 'default', third._id)).resolves.toMatchObject(refusal);
    });

    it('picks nobody for no person at all, and asks no pod about it', async () => {
      const find = jest.spyOn(Pod, 'find');
      await expect(hostedRuntime.resolveHostedOwner(NAME, 'default', undefined)).resolves.toMatchObject(refusal);
      await expect(hostedRuntime.resolveHostedOwner(NAME, 'default', null)).resolves.toMatchObject(refusal);
      expect(find).not.toHaveBeenCalled();
    });

    it('refuses an admin who shares no pod, with a code and no one\'s account in it', async () => {
      const response = await talkTo(admin);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('hosted_no_shared_owner');
      expect(response.body.room).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toMatch(new RegExp(`${owner.username}|${owner.email}|${owner._id}`));
      await expect(rooms()).resolves.toBe(0);
    });

    it('refuses a pod member whose pod has only a row an agent wrote for itself', async () => {
      const botPod = await pod('Bot pod', [third._id, bot._id]);
      await seedRow(bot._id, botPod._id);
      const response = await talkTo(third);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('hosted_no_shared_owner');
      await expect(rooms()).resolves.toBe(0);
    });

    it('refuses another agent on the runtime-token path the same way', async () => {
      const botPod = await pod('Bot pod', [third._id, bot._id]);
      await seedRow(bot._id, botPod._id);
      await seedRow(third._id, botPod._id, {
        agentName: 'caller-agent', config: { runtime: { runtimeType: 'webhook' } },
      });
      const issued = await request(app)
        .post(`/api/registry/pods/${botPod._id}/agents/caller-agent/runtime-tokens`)
        .set('Authorization', bearer(third)).send({ label: 'caller' });
      expect(issued.status).toBe(200);
      const caller = await User.findOne({ username: 'caller-agent', isBot: true }).lean();
      await addMember(botPod._id, caller);
      const response = await request(app).post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${issued.body.token}`).send({ agentName: NAME, instanceId: 'default' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('hosted_no_shared_owner');
      await expect(rooms()).resolves.toBe(0);
    });

    it('writes nothing and charges nobody on a refusal', async () => {
      const rowsBefore = await AgentInstallation.find({}).sort({ _id: 1 }).lean();
      await expect(openRoom(third)).rejects.toMatchObject({ code: 'hosted_no_shared_owner', status: 403 });
      await expect(rooms()).resolves.toBe(0);
      expect(await AgentInstallation.find({}).sort({ _id: 1 }).lean()).toEqual(rowsBefore);
      await expect(AgentRun.countDocuments({})).resolves.toBe(0);
      await expect(hostedRuntime.countHostedAgentsForUser(third._id)).resolves.toBe(0);
    });

    it('still opens a room that already exists, and leaves its row', async () => {
      const room = await pod('Admin room', [bot._id, admin._id], 'agent-room');
      await seedRow(owner._id, room._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      const before = await roomRow(room);
      const response = await talkTo(admin);
      expect(response.status).toBe(200);
      expect(String(response.body.room._id)).toBe(String(room._id));
      expect(await roomRow(room)).toEqual(before);
    });

    it('bounds the pod read and wraps the person in $eq', async () => {
      await seedRow(third._id, (await pod('Elsewhere', [third._id, bot._id]))._id);
      const real = Pod.find.bind(Pod);
      const queries = [];
      jest.spyOn(Pod, 'find').mockImplementation((...args) => {
        const query = real(...args);
        queries.push(query);
        return query;
      });
      await hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id);
      expect(queries).toHaveLength(1);
      expect(queries[0].getOptions().limit).toBe(hostedRuntime.HOSTED_OWNER_POD_SCAN);
      expect(String(queries[0].getFilter().members.$eq)).toBe(String(guest._id));
    });

    it('asks about no more pods than the bound, oldest first, and fails closed past it', async () => {
      await AgentInstallation.deleteMany({});
      const cap = hostedRuntime.HOSTED_OWNER_POD_SCAN;
      const pastTheBound = await pod('Past the bound', [owner._id, guest._id, bot._id]);
      await AgentInstallation.collection.insertMany(Array.from({ length: cap }, (_, index) => ({
        _id: id(index + 1),
        agentName: NAME,
        instanceId: 'default',
        podId: new mongoose.Types.ObjectId(),
        installedBy: third._id,
        version: '1.0.0',
        status: 'active',
        config: hostedConfig(),
      })));
      await seedRow(owner._id, pastTheBound._id, { _id: id(cap + 1) });
      await expect(hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id)).resolves.toMatchObject(refusal);
    });
  });

  describe('a paused install', () => {
    const paused = { status: 'paused' };
    const twoOwners = async () => {
      const older = await pod('Paused owner', [owner._id, guest._id, bot._id]);
      const newer = await pod('Running owner', [third._id, guest._id, bot._id]);
      await AgentInstallation.deleteMany({});
      await seedRow(owner._id, older._id, paused);
      await seedRow(third._id, newer._id);
    };

    it('is passed over for a running owner the person shares a pod with', async () => {
      await twoOwners();
      const room = await openRoom(guest);
      expect(await roomRow(room)).toMatchObject({ status: 'active', installedBy: third._id });
    });

    it('is never charged because it is the only owner the person shares a pod with', async () => {
      await AgentInstallation.deleteMany({});
      await seedRow(owner._id, workspace._id, paused);
      const elsewhere = await pod('Elsewhere', [third._id, bot._id]);
      await seedRow(third._id, elsewhere._id);
      await expect(hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id))
        .resolves.toMatchObject({ ownerId: null, live: true });
    });

    it('does not let a person\'s own paused row win while someone they share a pod with runs it', async () => {
      await twoOwners();
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', owner._id);
      expect(found).toMatchObject({ ownerId: null, live: true });
      await Pod.updateOne({ name: 'Running owner' }, { $addToSet: { members: owner._id } });
      const shared = await hostedRuntime.resolveHostedOwner(NAME, 'default', owner._id);
      expect(String(shared.ownerId)).toBe(String(third._id));
    });

    it('stays live when the whole agent is paused, so a resume finds the room', async () => {
      await AgentInstallation.updateMany({}, { $set: paused });
      const found = await hostedRuntime.resolveHostedOwner(NAME, 'default', guest._id);
      expect(found).toMatchObject({ live: true, paused: true });
      const room = await openRoom(guest);
      expect(await roomRow(room)).toMatchObject({ status: 'paused', installedBy: owner._id });
      const ownRoom = await hostedRuntime.resolveHostedOwner(NAME, 'default', owner._id);
      expect(ownRoom).toMatchObject({ live: true, paused: true });
      expect(String(ownRoom.ownerId)).toBe(String(owner._id));
    });

    it('starts the room paused when a stray running row hides that every owner paused', async () => {
      await AgentInstallation.updateMany({}, { $set: paused });
      const botPod = await pod('Bot pod', [guest._id, bot._id]);
      await seedRow(bot._id, botPod._id);
      const room = await openRoom(guest);
      expect(await roomRow(room)).toMatchObject({ status: 'paused', installedBy: owner._id });
    });

    it('never retires the rooms of a paused agent', async () => {
      const room = await openRoom(guest);
      const legacy = await pod('Room of third', [bot._id, third._id], 'agent-room');
      await seedRow(owner._id, legacy._id, { status: 'paused', config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      await AgentInstallation.updateMany({}, { $set: paused });
      await Pod.updateOne({ _id: workspace._id }, { $addToSet: { members: third._id } });
      const before = await AgentInstallation.find({}).sort({ _id: 1 }).lean();
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ scanned: 2, unchanged: 2, reassigned: [], retired: [], unresolved: [] });
      expect(await AgentInstallation.find({}).sort({ _id: 1 }).lean()).toEqual(before);
      expect((await roomRow(room)).status).toBe('paused');
    });

    it('reports a running room on a paused agent, even when it names the right owner', async () => {
      const legacy = await pod('Room of guest', [bot._id, guest._id], 'agent-room');
      await seedRow(owner._id, legacy._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: paused });
      const before = await roomRow(legacy);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ unchanged: 0, reassigned: [], unresolved: [String(before._id)] });
      expect(await roomRow(legacy)).toEqual(before);
    });

    describe('when an agent has more than one owner and all of them paused', () => {
      const resume = (user, podId) => request(app)
        .patch(`/api/registry/pods/${podId}/agents/${NAME}`)
        .set('Authorization', bearer(user))
        .send({ status: 'active' });
      let ownerPod;
      let thirdPod;
      let ownerRoom;
      let thirdRoom;

      beforeEach(async () => {
        await twoOwners();
        ownerPod = await Pod.findOne({ name: 'Paused owner' });
        thirdPod = await Pod.findOne({ name: 'Running owner' });
        await AgentInstallation.updateMany({}, { $set: paused });
        ownerRoom = await pod('Room on the owner', [bot._id, guest._id], 'agent-room');
        thirdRoom = await pod('Room on the other owner', [bot._id, admin._id], 'agent-room');
        const roomConfig = hostedConfig({ autoJoinSource: ROOM_SOURCE });
        await seedRow(owner._id, ownerRoom._id, { ...paused, config: roomConfig });
        await seedRow(third._id, thirdRoom._id, { ...paused, config: roomConfig });
      });

      it('wakes the rooms a resuming owner pays for and leaves the other owner\'s', async () => {
        const res = await resume(owner, ownerPod._id);
        expect(res.status).toBe(200);
        expect((await roomRow(ownerRoom)).status).toBe('active');
        expect((await roomRow(thirdRoom)).status).toBe('paused');
        expect((await AgentInstallation.findOne({ podId: thirdPod._id }).lean()).status).toBe('paused');
      });

      it('gives the person in the room no say over a row someone else pays for', async () => {
        const res = await resume(guest, ownerRoom._id);
        expect(res.status).toBe(403);
        expect((await roomRow(ownerRoom)).status).toBe('paused');
      });

      it('leaves a co-owner\'s pause where it is: only a resume crosses that line', async () => {
        await AgentInstallation.updateMany({}, { $set: { status: 'active' } });
        await request(app).patch(`/api/registry/pods/${ownerPod._id}/agents/${NAME}`)
          .set('Authorization', bearer(owner)).send({ status: 'paused' });
        expect((await roomRow(ownerRoom)).status).toBe('active');
      });
    });

    it('leaves a running guest row unresolved rather than put it on a paused owner', async () => {
      const legacy = await pod('Room of guest', [bot._id, guest._id], 'agent-room');
      await seedRow(guest._id, legacy._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: paused });
      const before = await roomRow(legacy);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ reassigned: [], retired: [], unresolved: [String(before._id)] });
      expect(await roomRow(legacy)).toEqual(before);
    });
  });

  describe('the owner backfill asks about the person in the room', () => {
    const strangerRoom = async (installedBy = third._id, person = third) => {
      const room = await pod('Room of a stranger', [bot._id, person._id], 'agent-room');
      await seedRow(installedBy, room._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      return room;
    };

    it.each([[false], [true]])('reports a stranger\'s row unresolved and leaves it (apply: %s)', async (apply) => {
      const room = await strangerRoom();
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners({ apply });
      expect(report).toEqual({
        scanned: 1, unchanged: 0, reassigned: [], retired: [], unresolved: [String(before._id)],
      });
      expect(await roomRow(room)).toEqual(before);
    });

    it('does not take a row that already names an owner the person shares no pod with for right', async () => {
      const room = await strangerRoom(owner._id);
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ unchanged: 0, reassigned: [], unresolved: [String(before._id)] });
      expect(await roomRow(room)).toEqual(before);
    });

    it('moves a row by the person in the room, not by who the row names now', async () => {
      const second = await pod('Second', [third._id, guest._id, bot._id]);
      await seedRow(third._id, second._id);
      await AgentInstallation.deleteOne({ podId: workspace._id });
      const room = await pod('Room of guest', [bot._id, guest._id], 'agent-room');
      await seedRow(owner._id, room._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }) });
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report.reassigned).toHaveLength(1);
      expect((await roomRow(room)).installedBy).toEqual(third._id);
    });

    it.each([
      ['has no person in it', (members) => members.slice(0, 1)],
      ['has two people in it', (members, extra) => [...members, extra]],
    ])('reports a room that %s unresolved', async (_label, shape) => {
      const room = await strangerRoom(guest._id, guest);
      await Pod.updateOne({ _id: room._id }, { $set: { members: shape([bot._id, guest._id], admin._id) } });
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ unchanged: 0, reassigned: [], unresolved: [String(before._id)] });
      expect(await roomRow(room)).toEqual(before);
    });

    it('reports a row whose room is gone unresolved', async () => {
      const room = await strangerRoom(guest._id, guest);
      await Pod.deleteOne({ _id: room._id });
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report.unresolved).toEqual([String(before._id)]);
      expect(await roomRow(room)).toEqual(before);
    });

    it('still retires a stranger\'s row once the agent is gone, without naming anyone new', async () => {
      const room = await strangerRoom();
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: { status: 'uninstalled' } });
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ retired: [String(before._id)], unresolved: [] });
      expect(await roomRow(room)).toMatchObject({ status: 'uninstalled', installedBy: third._id });
    });
  });

  describe('rows written before this rule', () => {
    const legacyRoom = async (person, overrides = {}) => {
      const room = await pod(`Room of ${person.username}`, [bot._id, person._id], 'agent-room');
      await seedRow(person._id, room._id, { config: hostedConfig({ autoJoinSource: ROOM_SOURCE }), ...overrides });
      return room;
    };

    it('changes nothing on a dry run', async () => {
      const room = await legacyRoom(guest);
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners();
      expect(report).toMatchObject({ scanned: 1, reassigned: [String(before._id)], retired: [], unresolved: [] });
      expect(await roomRow(room)).toEqual(before);
    });

    it('puts a row under its owner, keeps it answering, and takes the guest\'s hold away', async () => {
      const room = await legacyRoom(guest);
      await expect(hostedRuntime.countHostedAgentsForUser(guest._id)).resolves.toBe(1);
      await reassignHostedRoomOwners({ apply: true });
      expect(await roomRow(room)).toMatchObject({ status: 'active', installedBy: owner._id });
      await expect(hostedRuntime.countHostedAgentsForUser(guest._id)).resolves.toBe(0);
      expect((await hostedPost(guest, 'deprovision')).status).toBe(404);
    });

    it('changes nothing on a second run', async () => {
      await legacyRoom(guest);
      await reassignHostedRoomOwners({ apply: true });
      const rows = await AgentInstallation.find({}).sort({ _id: 1 }).lean();
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report).toMatchObject({ scanned: 1, unchanged: 1, reassigned: [], retired: [], unresolved: [] });
      expect(await AgentInstallation.find({}).sort({ _id: 1 }).lean()).toEqual(rows);
    });

    it('covers an older row that stores no runtime and inherits one when it runs', async () => {
      const room = await legacyRoom(guest, { config: { heartbeat: { enabled: false }, autoJoinSource: ROOM_SOURCE } });
      await reassignHostedRoomOwners({ apply: true });
      expect((await roomRow(room)).installedBy).toEqual(owner._id);
    });

    it('retires a row whose agent its owner has removed, the guest\'s or the owner\'s own', async () => {
      const guestRoom = await legacyRoom(guest);
      const ownRoom = await legacyRoom(owner);
      await AgentInstallation.updateOne({ podId: workspace._id }, { $set: { status: 'uninstalled' } });
      await reassignHostedRoomOwners({ apply: true });
      expect(await roomRow(guestRoom)).toMatchObject({ status: 'uninstalled', installedBy: owner._id });
      expect((await roomRow(ownRoom)).status).toBe('uninstalled');
    });

    it('reports a row nobody owns and leaves it', async () => {
      await AgentInstallation.deleteMany({ podId: workspace._id });
      const room = await legacyRoom(guest);
      const before = await roomRow(room);
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report.unresolved).toEqual([String(before._id)]);
      expect(await roomRow(room)).toEqual(before);
    });

    it('leaves a person who hosts the agent themselves on their own room', async () => {
      const theirs = await pod('Theirs', [guest._id, bot._id]);
      await seedRow(guest._id, theirs._id);
      const room = await legacyRoom(guest);
      await reassignHostedRoomOwners({ apply: true });
      expect((await roomRow(room)).installedBy).toEqual(guest._id);
    });

    it('leaves a DM row on another runtime alone', async () => {
      const room = await legacyRoom(guest, { config: { runtime: { runtimeType: 'native' }, autoJoinSource: ROOM_SOURCE } });
      const report = await reassignHostedRoomOwners({ apply: true });
      expect(report.scanned).toBe(0);
      expect((await roomRow(room)).installedBy).toEqual(guest._id);
    });
  });
});
