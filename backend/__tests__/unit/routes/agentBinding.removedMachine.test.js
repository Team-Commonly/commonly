// F476: removing a computer clears its agents' binding, and the agent then
// read as a terminal agent in Settings with nothing said about the computer.
// Removal now leaves the computer's name on the agent until a daemon adopts it
// or its owner releases it, and only the owner's placement read hands it out.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => {
  const mw = (req, res, next) => { req.user = { id: global.__CALLER_ID, role: global.__CALLER_ROLE }; next(); };
  mw.touchLastActive = jest.fn();
  return mw;
});

const { hash } = require('../../../utils/secret');

let mongod; let app; let AgentCredential; let User; let AgentInstallation; let Machine; let Pod; let machineService;
const DAEMON_A = `cm_daemon_${'c'.repeat(32)}`;
const DAEMON_B = `cm_daemon_${'d'.repeat(32)}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentCredential = require('../../../models/AgentCredential');
  User = require('../../../models/User');
  Machine = require('../../../models/Machine');
  Pod = require('../../../models/Pod');
  AgentInstallation = require('../../../models/AgentRegistry').AgentInstallation;
  machineService = require('../../../services/machineService');
  app = express();
  app.use(express.json());
  app.use('/api/agent-binding', require('../../../routes/agentBinding'));
});

afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let owner; let machineA;
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), AgentCredential.deleteMany({}), AgentInstallation.deleteMany({}), Machine.deleteMany({}), Pod.deleteMany({}),
  ]);
  owner = await User.create({ username: `o${Date.now() % 1e6}`, email: `o${Date.now()}@x.com`, password: 'x'.repeat(12) });
  global.__CALLER_ID = String(owner._id);
  global.__CALLER_ROLE = undefined;
  const bot = await User.create({
    username: `b${Date.now() % 1e6}`, email: `b${Date.now()}@agents.commonly.local`, password: 'x'.repeat(12),
    isBot: true, botMetadata: { agentName: 'wren-test', instanceId: 'default', machineId: 'machine-a' },
  });
  const pod = await Pod.create({ name: `p${Date.now()}`, createdBy: owner._id, members: [owner._id, bot._id] });
  await AgentInstallation.create({
    agentName: 'wren-test', instanceId: 'default', podId: pod._id, version: '1.0.0', status: 'active', installedBy: owner._id,
    config: { runtime: { runtimeType: 'wrapper' } },
  });
  for (const [tok, mid] of [[DAEMON_A, 'machine-a'], [DAEMON_B, 'machine-b']]) {
    // eslint-disable-next-line no-await-in-loop
    await AgentCredential.create({
      tokenHash: hash(tok), kind: 'daemon', ownerUserId: owner._id, machineId: mid, scopes: ['machine:heartbeat', 'agents:adopt'],
    });
  }
  machineA = await Machine.create({ ownerUserId: owner._id, machineId: 'machine-a', name: 'Studio Mac' });
  await Machine.create({ ownerUserId: owner._id, machineId: 'machine-b', name: 'Laptop' });
});

const placement = () => request(app).get('/api/agent-binding/placement').query({ agentName: 'wren-test', instanceId: 'default' });
const removeA = () => machineService.removeMachine({ machineDbId: String(machineA._id), actorUserId: String(owner._id), isAdmin: false });

describe('an agent whose computer was removed', () => {
  it('names the removed computer in placement, and nothing while it is bound', async () => {
    expect((await placement().expect(200)).body.removedMachine).toBeNull();
    expect(await removeA()).toBe('removed');
    const after = (await placement().expect(200)).body;
    expect(after.boundMachineId).toBeNull();
    expect(after.removedMachine).toMatchObject({ name: 'Studio Mac' });
    expect(new Date(after.removedMachine.at).getTime()).toBeGreaterThan(0);
  });

  it('forgets it once the agent is adopted on another computer', async () => {
    await removeA();
    await request(app).post('/api/agent-binding/adopt').set('Authorization', `Bearer ${DAEMON_B}`)
      .send({ agentName: 'wren-test', instanceId: 'default' }).expect(200);
    const after = (await placement().expect(200)).body;
    expect(after.boundMachineId).toBe('machine-b');
    expect(after.removedMachine).toBeNull();
  });

  it('keeps it while a move waits for the other computer, and forgets it on release', async () => {
    await removeA();
    await request(app).post('/api/agent-binding/move')
      .send({ agentName: 'wren-test', instanceId: 'default', machineId: 'machine-b', fromMachineId: null }).expect(200);
    const waiting = (await placement().expect(200)).body;
    expect(waiting.requestedMachineId).toBe('machine-b');
    expect(waiting.removedMachine).toMatchObject({ name: 'Studio Mac' });

    await request(app).post('/api/agent-binding/release').send({ agentName: 'wren-test', instanceId: 'default' }).expect(200);
    expect((await placement().expect(200)).body.removedMachine).toBeNull();
  });

  // Many reads send an agent's botMetadata to other people whole (the post
  // routes populate it), so the name lives outside it and is never selected by default.
  it('is not returned by an ordinary read of the agent, nor with its botMetadata', async () => {
    await removeA();
    const plain = await User.findOne({ isBot: true }).lean();
    expect(plain.removedMachine).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain('Studio Mac');
    const withMeta = await User.findOne({ isBot: true }).select('username isBot botMetadata').lean();
    expect(JSON.stringify(withMeta)).not.toContain('Studio Mac');
  });

  // A computer's name is its owner's: a stranger asking for the placement is
  // refused, and nothing in the refusal names the computer or carries the field.
  it('refuses a non-owner the placement, and the refusal names nothing about the computer', async () => {
    await removeA();
    const stranger = await User.create({ username: `s${Date.now() % 1e6}`, email: `s${Date.now()}@x.com`, password: 'x'.repeat(12) });
    global.__CALLER_ID = String(stranger._id);
    const refused = await placement();
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('Studio Mac');
    expect(JSON.stringify(refused.body)).not.toContain('removedMachine');
  });
});
