// The agent room's Connect link: the room's own install is a
// copy, and Bring your own refuses a DM pod, so the row must name the pod that
// holds the agent. Real models and the real route.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const podsRouter = require('../../routes/pods');

const SECRET = 'agent-states-room-connect-test';
const BYO = { runtimeType: 'webhook', host: 'byo' };

describe('GET /api/pods/:podId/agent-states in an agent room', () => {
  let app; let owner; let other; let home; let authHeader;

  const makePod = (name, type, extra = {}) => Pod.create({
    name, type, createdBy: owner._id, members: [owner._id], ...extra,
  });
  const install = (agentName, podId, runtime = BYO, installedBy = owner._id, instanceId = 'default') => AgentInstallation.create({
    agentName, instanceId, podId, version: '1', installedBy, config: new Map([['runtime', runtime]]),
  });
  const rowIn = async (room, agentName) => {
    const res = await request(app).get(`/api/pods/${room._id}/agent-states`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    return res.body.agents.find((a) => a.agentName === agentName);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/pods', podsRouter);
    owner = await User.create({ username: 'room-owner', email: 'room-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'room-other', email: 'room-other@test.com', password: 'password123' });
    home = await makePod('Home', 'chat');
    authHeader = `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`;
  });

  afterAll(async () => closeMongoDb());

  it('names the pod that holds the agent, not the room', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('plain', home._id);
    await install('plain', room._id);
    const row = await rowIn(room, 'plain');
    expect(row.state).toBe('never-connected');
    expect(row.connectPodId).toBe(String(home._id));
  });

  it('gives a wrapper none: Reconnect refuses an agent never bound to a computer', async () => {
    const room = await makePod('Room', 'agent-room');
    const wrapper = { runtimeType: 'wrapper', host: 'byo' };
    await install('bound', home._id, wrapper);
    await install('bound', room._id, wrapper);
    const row = await rowIn(room, 'bound');
    expect(row.fixCommand).toBe('commonly agent run bound');
    expect(row.connectPodId).toBeUndefined();
  });

  it('gives a seat bound to a machine none, whatever its install says', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('seat', home._id);
    await install('seat', room._id);
    await User.create({
      username: 'seat',
      email: 'seat@test.com',
      password: 'password123',
      isBot: true,
      botMetadata: { agentName: 'seat', instanceId: 'default', machineId: new mongoose.Types.ObjectId() },
    });
    expect((await rowIn(room, 'seat')).connectPodId).toBeUndefined();
  });

  it('gives someone who did not install it none', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('theirs', home._id, BYO, other._id);
    await install('theirs', room._id, BYO, other._id);
    expect((await rowIn(room, 'theirs')).connectPodId).toBeUndefined();
  });

  it('skips pods the page would refuse, and gives none when nothing is left', async () => {
    const room = await makePod('Room', 'agent-room');
    const secondRoom = await makePod('Other room', 'agent-room');
    const open = await makePod('Open', 'chat', { publicRead: true });
    await install('stranded', room._id);
    await install('stranded', secondRoom._id);
    await install('stranded', open._id);
    expect((await rowIn(room, 'stranded')).connectPodId).toBeUndefined();
  });

  it('leaves a group pod alone: its rows carry no such field', async () => {
    const second = await makePod('Second', 'chat');
    await install('group', home._id);
    await install('group', second._id);
    const row = await rowIn(home, 'group');
    expect(row.state).toBe('never-connected');
    expect(row.connectPodId).toBeUndefined();
  });

  it("does not name another person's pod to a guest who holds the room's install", async () => {
    const room = await makePod('Room', 'agent-room');
    await install('guested', home._id, BYO, other._id);
    await install('guested', room._id);
    const row = await rowIn(room, 'guested');
    expect(row.fixCommand).toBeTruthy();
    expect(row.connectPodId).toBeUndefined();
  });

  it('gives no link when the room install is someone else\'s, so there is no command', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('borrowed', home._id);
    await install('borrowed', room._id, BYO, other._id);
    expect((await rowIn(room, 'borrowed')).connectPodId).toBeUndefined();
  });

  it('skips a pod the caller has left', async () => {
    const room = await makePod('Room', 'agent-room');
    const left = await Pod.create({
      name: 'Left', type: 'chat', createdBy: other._id, members: [other._id],
    });
    await install('left', left._id);
    await install('left', room._id);
    expect((await rowIn(room, 'left')).connectPodId).toBeUndefined();
  });

  it('skips an install that was removed', async () => {
    const room = await makePod('Room', 'agent-room');
    const gone = await install('removed', home._id);
    await install('removed', room._id);
    await AgentInstallation.updateOne({ _id: gone._id }, { status: 'uninstalled' });
    expect((await rowIn(room, 'removed')).connectPodId).toBeUndefined();
  });

  it('names the oldest of several pods', async () => {
    const room = await makePod('Room', 'agent-room');
    const older = await makePod('Older', 'chat');
    await install('twice', home._id);
    const first = await install('twice', older._id);
    await install('twice', room._id);
    await AgentInstallation.collection.updateOne(
      { _id: first._id },
      { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } },
    );
    expect((await rowIn(room, 'twice')).connectPodId).toBe(String(older._id));
  });

  it('gives an agent that went dark none: it already connected once', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('dark', home._id);
    const row = await install('dark', room._id);
    await AgentInstallation.collection.updateOne(
      { _id: row._id },
      { $set: { runtimeTokens: [{ lastListenedAt: new Date('2026-01-01T00:00:00Z') }] } },
    );
    const dark = await rowIn(room, 'dark');
    expect(dark.state).toBe('gone-dark');
    expect(dark.fixCommand).toBeTruthy();
    expect(dark.connectPodId).toBeUndefined();
  });

  it('gives a second instance none: the page would make a sibling', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('persona', home._id, BYO, owner._id, 'nova');
    await install('persona', room._id, BYO, owner._id, 'nova');
    const row = await rowIn(room, 'persona');
    expect(row.state).toBe('never-connected');
    expect(row.connectPodId).toBeUndefined();
  });

  it('keeps the notice when the lookup fails', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('flaky', home._id);
    await install('flaky', room._id);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const find = jest.spyOn(Pod, 'find').mockImplementationOnce(() => { throw new Error('read failed'); });
    const row = await rowIn(room, 'flaky');
    find.mockRestore();
    warn.mockRestore();
    expect(row.fixCommand).toBeTruthy();
    expect(row.connectPodId).toBeUndefined();
  });
});
