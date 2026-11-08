/**
 * A personal pod holds the agent it was made with. Install in one answers for
 * that agent and refuses any other, so a 200 never stands for a row the agent
 * can't use (ADR-001 §3.10).
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');

const registryRoutes = require('../../routes/registry');

const JWT_SECRET = 'test-jwt-secret-install-personal-pod';

jest.setTimeout(60000);

describe('installing into a personal pod', () => {
  let app;
  let person;
  let token;
  let resident;

  const install = (podId, agentName) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${token}`)
    .send({
      agentName,
      instanceId: 'default',
      podId: podId.toString(),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: [],
    });

  const personalPod = (type) => Pod.create({
    name: `${type} room`,
    type,
    createdBy: person._id,
    members: [person._id, resident._id],
  });

  const rowsIn = (podId, agentName) => AgentInstallation.countDocuments({ agentName, podId, status: { $ne: 'uninstalled' } });

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}), Pod.deleteMany({}), AgentRegistry.deleteMany({}), AgentInstallation.deleteMany({}),
    ]);
    person = await User.create({
      username: 'room-person', email: 'room-person@example.test', password: 'password123', verified: true,
    });
    token = jwt.sign({ id: person._id }, JWT_SECRET);
    const teamPod = await Pod.create({ name: 'home', type: 'chat', createdBy: person._id, members: [person._id] });
    expect((await install(teamPod._id, 'resident')).status).toBe(200);
    resident = await User.findOne({ username: AgentIdentityService.buildAgentUsername('resident', 'default'), isBot: true });
  });

  it.each(['agent-room', 'agent-dm', 'agent-admin'])('refuses an agent that is not in the %s pod, and writes no row', async (type) => {
    const pod = await personalPod(type);
    const res = await install(pod._id, 'stranger');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('dm_membership_refused');
    expect(await rowsIn(pod._id, 'stranger')).toBe(0);
    const after = await Pod.findById(pod._id).lean();
    expect(after.members.map(String).sort()).toEqual([String(person._id), String(resident._id)].sort());
    expect(await AgentRegistry.countDocuments({ agentName: 'stranger' })).toBe(0);
    expect(await User.countDocuments({ username: AgentIdentityService.buildAgentUsername('stranger', 'default') })).toBe(0);
  });

  it('refuses before any write, so a failed identity read can\'t let a row through', async () => {
    const pod = await personalPod('agent-room');
    const spy = jest.spyOn(AgentIdentityService, 'getOrCreateAgentUser').mockRejectedValue(new Error('transient'));
    try {
      const res = await install(pod._id, 'stranger');
      expect(res.status).toBe(403);
      expect(await rowsIn(pod._id, 'stranger')).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an agent taken out of its room, because the row could not be used', async () => {
    const pod = await personalPod('agent-room');
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: resident._id } });
    await AgentInstallation.collection.insertOne({
      agentName: 'resident', instanceId: 'default', podId: pod._id, installedBy: person._id,
      version: '1.0.0', status: 'uninstalled', createdAt: new Date(), config: {},
    });

    const res = await install(pod._id, 'resident');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('dm_membership_refused');
    expect(await rowsIn(pod._id, 'resident')).toBe(0);
  });

  it.each(['agent-room', 'agent-dm', 'agent-admin'])('still installs the agent the %s pod was made with', async (type) => {
    const pod = await personalPod(type);
    const res = await install(pod._id, 'resident');

    expect(res.status).toBe(200);
    expect(await rowsIn(pod._id, 'resident')).toBe(1);
  });

  it('leaves a team pod alone', async () => {
    const pod = await Pod.create({ name: 'team', type: 'chat', createdBy: person._id, members: [person._id] });
    const res = await install(pod._id, 'stranger');

    expect(res.status).toBe(200);
    expect(await rowsIn(pod._id, 'stranger')).toBe(1);
  });
});
