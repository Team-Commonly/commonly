process.env.PG_HOST = '';
process.env.JWT_SECRET = 'leave-socket-rooms-test-secret';

jest.mock('jsonwebtoken', () => ({
  sign: ({ id }) => `test-token:${id}`,
  verify: (token) => ({ id: token.replace('test-token:', '') }),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const socketConfig = require('../../config/socket');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const podInvitesRoutes = require('../../routes/podInvites');
const podRoutes = require('../../routes/pods');
const { sessionSocketRoom } = require('../../services/sessionSocketService');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

// A browser socket enters a pod room once, at joinPod, through canViewPod.
// Leaving a pod, or being removed from one, must take the user's open sockets
// out of every pod room canViewPod no longer admits them to. Real Mongo and a
// real Socket.IO server, so room membership is what the adapter reports.
describe('pod socket rooms after a membership change', () => {
  let app;
  let httpServer;
  let io;
  let url;
  let clients;
  let owner;
  let member;
  let admin;
  let agentA;
  let agentB;
  let pod;
  let agentDm;

  const makeUser = (name, extra = {}) => User.create({
    username: `${name}-${new mongoose.Types.ObjectId()}`,
    email: `${name}-${new mongoose.Types.ObjectId()}@test.com`,
    password: 'Password123!',
    verified: true,
    ...extra,
  });
  const auth = (user) => `Bearer ${jwt.sign({ id: user._id }, process.env.JWT_SECRET)}`;
  const room = (target) => `pod_${target._id}`;

  // The production handshake puts every browser socket in its user's session
  // room (server.ts). The pod rooms are joined directly here: the code under
  // test is what happens after a membership change, not joinPod itself.
  const connect = (user) => new Promise((resolve, reject) => {
    const client = connectClient(url, { auth: { userId: String(user._id) }, forceNew: true });
    clients.push(client);
    client.once('ready', () => resolve(client));
    client.once('connect_error', reject);
  });
  const joinRooms = async (user, ...pods) => {
    await Promise.all(pods.map((target) => io.in(sessionSocketRoom(String(user._id))).socketsJoin(room(target))));
  };
  const usersIn = async (target) => {
    const sockets = await io.in(room(target)).fetchSockets();
    return sockets.map((socket) => socket.data.userId).sort();
  };

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api', podInvitesRoutes);
    app.use('/api/pods', podRoutes);

    httpServer = http.createServer();
    io = new Server(httpServer);
    io.on('connection', (socket) => {
      socket.data.userId = socket.handshake.auth.userId;
      socket.join(sessionSocketRoom(socket.data.userId));
      socket.emit('ready');
    });
    await socketConfig.init(io);
    await new Promise((resolve) => { httpServer.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${httpServer.address().port}`;
  });

  beforeEach(async () => {
    clients = [];
    await clearMongoDb();
    owner = await makeUser('owner');
    member = await makeUser('member');
    admin = await makeUser('admin', { role: 'admin' });
    agentA = await makeUser('agent-a', { isBot: true });
    agentB = await makeUser('agent-b', { isBot: true });
    pod = await Pod.create({
      name: 'team pod',
      type: 'team',
      createdBy: owner._id,
      members: [owner._id, member._id, admin._id, agentA._id],
    });
    // The member can view this DM only through `pod`, which they share with agentA.
    agentDm = await Pod.create({
      name: 'a <-> b',
      type: 'agent-dm',
      createdBy: agentA._id,
      members: [agentA._id, agentB._id],
    });
  });

  afterEach(() => {
    clients.forEach((client) => client.disconnect());
  });

  afterAll(async () => {
    io.close();
    await clearMongoDb();
    await closeMongoDb();
  });

  it('takes every open tab of a member who leaves out of the pod room', async () => {
    const ownerTab = await connect(owner);
    const tabs = [await connect(member), await connect(member)];
    await joinRooms(owner, pod);
    await joinRooms(member, pod);

    await request(app).post(`/api/pods/${pod._id}/leave`).set('Authorization', auth(member)).expect(200);

    expect(await usersIn(pod)).toEqual([String(owner._id)]);
    // Room emits still reach the owner and no longer reach either tab: each tab
    // sees the fence after the probe would have arrived, on the same connection.
    const seen = tabs.map((tab) => new Promise((resolve) => {
      let probed = false;
      tab.on('probe', () => { probed = true; });
      tab.once('fence', () => resolve(probed));
    }));
    const ownerProbed = new Promise((resolve) => { ownerTab.once('probe', () => resolve(true)); });
    io.to(room(pod)).emit('probe');
    io.to(sessionSocketRoom(String(member._id))).emit('fence');
    expect(await Promise.all(seen)).toEqual([false, false]);
    expect(await ownerProbed).toBe(true);
  });

  it('takes a removed member out of the pod room', async () => {
    await connect(owner);
    await connect(member);
    await joinRooms(owner, pod);
    await joinRooms(member, pod);

    await request(app)
      .delete(`/api/pods/${pod._id}/members/${member._id}`)
      .set('Authorization', auth(owner))
      .expect(200);

    expect(await usersIn(pod)).toEqual([String(owner._id)]);
  });

  it('also ends an agent-dm room the member could see only through the pod they left', async () => {
    await connect(member);
    await joinRooms(member, pod, agentDm);

    await request(app).post(`/api/pods/${pod._id}/leave`).set('Authorization', auth(member)).expect(200);

    expect(await usersIn(pod)).toEqual([]);
    expect(await usersIn(agentDm)).toEqual([]);
  });

  it('keeps an agent-dm room the member can still see through another shared pod', async () => {
    await Pod.create({
      name: 'other pod',
      type: 'team',
      createdBy: owner._id,
      members: [owner._id, member._id, agentB._id],
    });
    await connect(member);
    await joinRooms(member, pod, agentDm);

    await request(app).post(`/api/pods/${pod._id}/leave`).set('Authorization', auth(member)).expect(200);

    expect(await usersIn(pod)).toEqual([]);
    expect(await usersIn(agentDm)).toEqual([String(member._id)]);
  });

  it('keeps a global admin in the room after they leave, since canViewPod still admits them', async () => {
    await connect(admin);
    await joinRooms(admin, pod);

    await request(app).post(`/api/pods/${pod._id}/leave`).set('Authorization', auth(admin)).expect(200);

    expect(await usersIn(pod)).toEqual([String(admin._id)]);
  });
});
