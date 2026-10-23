const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken } = require('../utils/testUtils');
const { hash } = require('../../utils/secret');
const { hashDeviceCredential } = require('../../services/deviceAuthorizationService');
const User = require('../../models/User');
const Machine = require('../../models/Machine');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));
app.use('/api/machines', require('../../routes/machines'));
app.use('/api/credentials', require('../../routes/credentials'));
app.get('/runtime-check', require('../../middleware/agentRuntimeAuth').default, (_req, res) => res.sendStatus(204));

const owner = async () => User.create({
  username: `owner-${new mongoose.Types.ObjectId().toString().slice(0, 8)}`,
  email: `${new mongoose.Types.ObjectId()}@example.test`,
  password: 'Password123!',
  verified: true,
});

const addDevice = async (user, suffix) => {
  const token = `cm_${suffix.repeat(64)}`;
  user.deviceTokens.push({
    tokenHash: hashDeviceCredential(token), label: `laptop-${suffix} · commonly-cli`, createdAt: new Date(),
  });
  await user.save();
  return { token, id: String(user.deviceTokens[user.deviceTokens.length - 1]._id) };
};

const register = async (token, name) => request(app)
  .post('/api/machines')
  .set('Authorization', `Bearer ${token}`)
  .send({ name })
  .expect(201);

const daemonCall = (token, machineDbId) => request(app)
  .post(`/api/machines/${machineDbId}/heartbeat`)
  .set('Authorization', `Bearer ${token}`)
  .send({ agents: [] });

const addRuntimeChild = async (user, machine, daemonToken, suffix) => {
  const bot = await User.create({
    username: `bot-${suffix}`, email: `bot-${suffix}@agents.commonly.local`,
    password: 'Password123!', isBot: true,
    botMetadata: { agentName: `bot-${suffix}`, instanceId: 'default', machineId: machine.machineId },
  });
  await AgentInstallation.create({
    agentName: `bot-${suffix}`, instanceId: 'default', podId: new mongoose.Types.ObjectId(),
    version: '1.0.0', installedBy: user._id,
  });
  const token = `cm_agent_${suffix.repeat(32)}`;
  bot.agentRuntimeTokens.push({ tokenHash: hash(token), label: 'seat', createdAt: new Date() });
  await bot.save();
  const daemon = await AgentCredential.findOne({ tokenHash: hash(daemonToken) });
  const child = await AgentCredential.create({
    tokenHash: hash(token), kind: 'runtime', ownerUserId: user._id,
    agentUserId: bot._id, machineId: machine.machineId, parentId: daemon._id,
  });
  return { token, child };
};

beforeAll(async () => {
  process.env.JWT_SECRET = 'machine-revocation-test-secret';
  await setupMongoDb();
});
afterEach(async () => clearMongoDb());
afterAll(async () => closeMongoDb());

describe('machine credential revocation', () => {
  it('revoking a CLI device removes its machine and rejects daemon and minted child on the next call', async () => {
    const user = await owner();
    const device = await addDevice(user, 'a');
    const otherDevice = await addDevice(user, 'b');
    const first = (await register(device.token, 'first')).body;
    const other = (await register(otherDevice.token, 'other')).body;
    const child = await addRuntimeChild(user, first.machine, first.daemonToken, 'first');

    await daemonCall(first.daemonToken, first.machine.id).expect(200);
    await request(app).get('/runtime-check').set('Authorization', `Bearer ${child.token}`).expect(204);

    await request(app).delete(`/api/auth/devices/${device.id}`)
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`).expect(200);

    expect(await Machine.findById(first.machine.id)).toBeNull();
    expect(await AgentCredential.findById(child.child._id)).toMatchObject({ status: 'revoked' });
    await daemonCall(first.daemonToken, first.machine.id).expect(401);
    await request(app).get('/runtime-check').set('Authorization', `Bearer ${child.token}`).expect(401);
    await daemonCall(other.daemonToken, other.machine.id).expect(200);
  });

  it('removing a machine revokes every daemon and minted child, including a standalone machine credential', async () => {
    const user = await owner();
    const device = await addDevice(user, 'c');
    const first = (await register(device.token, 'first')).body;
    const child = await addRuntimeChild(user, first.machine, first.daemonToken, 'removed');
    const extraToken = `cm_daemon_${'e'.repeat(32)}`;
    await AgentCredential.create({
      tokenHash: hash(extraToken), kind: 'daemon', ownerUserId: user._id,
      machineId: first.machine.machineId, scopes: ['machine:heartbeat'],
    });

    await request(app).delete(`/api/machines/${first.machine.id}`)
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`).expect(200);

    const remaining = await AgentCredential.find({ machineId: first.machine.machineId });
    expect(remaining).toHaveLength(3);
    expect(remaining.every((credential) => credential.status === 'revoked')).toBe(true);
    await daemonCall(first.daemonToken, first.machine.id).expect(401);
    await daemonCall(extraToken, first.machine.id).expect(401);
    await request(app).get('/runtime-check').set('Authorization', `Bearer ${child.token}`).expect(401);

    // An in-flight mint can commit after a deletion's credential scan. The
    // machine-existence check must still refuse that otherwise-active row.
    await AgentCredential.updateMany(
      { machineId: first.machine.machineId },
      { $set: { status: 'active', revokedAt: null } },
    );
    await daemonCall(first.daemonToken, first.machine.id).expect(401);
    await request(app).get('/runtime-check').set('Authorization', `Bearer ${child.token}`).expect(401);
  });

  it('revoking a daemon credential in the owner UI rejects it and its minted child on the next call', async () => {
    const user = await owner();
    const device = await addDevice(user, 'f');
    const first = (await register(device.token, 'credential-revoke')).body;
    const child = await addRuntimeChild(user, first.machine, first.daemonToken, 'credential');
    const daemon = await AgentCredential.findOne({ tokenHash: hash(first.daemonToken) });

    await request(app).delete(`/api/credentials/${daemon._id}`)
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`).expect(200);

    expect(await AgentCredential.findById(child.child._id)).toMatchObject({ status: 'revoked' });
    await daemonCall(first.daemonToken, first.machine.id).expect(401);
    await request(app).get('/runtime-check').set('Authorization', `Bearer ${child.token}`).expect(401);
  });

  it('retires pre-binding machines conservatively when their owner revokes a device', async () => {
    const user = await owner();
    const device = await addDevice(user, 'd');
    const first = (await register(device.token, 'older')).body;
    await Machine.updateOne({ _id: first.machine.id }, { $unset: { registeredByDeviceTokenHash: 1 } });

    await request(app).delete(`/api/auth/devices/${device.id}`)
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`).expect(200);

    expect(await Machine.findById(first.machine.id)).toBeNull();
    await daemonCall(first.daemonToken, first.machine.id).expect(401);
  });

  it('keeps a new browser-registered machine separate from an unrelated revoked device', async () => {
    const user = await owner();
    const device = await addDevice(user, 'g');
    const browserToken = generateTestToken(user._id);
    const machine = (await register(browserToken, 'browser-registered')).body;

    expect((await Machine.findById(machine.machine.id)).registeredByDeviceTokenHash).toBeNull();
    await request(app).delete(`/api/auth/devices/${device.id}`)
      .set('Authorization', `Bearer ${browserToken}`).expect(200);

    expect(await Machine.findById(machine.machine.id)).toBeTruthy();
    await daemonCall(machine.daemonToken, machine.machine.id).expect(200);
  });

  it('a device revoke racing registration cannot leave a newly minted daemon alive', async () => {
    const user = await owner();
    const device = await addDevice(user, 'h');
    let continueCheck;
    let checkStarted;
    const started = new Promise((resolve) => { checkStarted = resolve; });
    const resume = new Promise((resolve) => { continueCheck = resolve; });
    const originalExists = User.exists.bind(User);
    const existsSpy = jest.spyOn(User, 'exists').mockImplementationOnce(async (...args) => {
      checkStarted();
      await resume;
      return originalExists(...args);
    });
    try {
      const registration = request(app).post('/api/machines')
        .set('Authorization', `Bearer ${device.token}`).send({ name: 'racing' });
      const pending = registration.then((response) => response);
      await started;
      await request(app).delete(`/api/auth/devices/${device.id}`)
        .set('Authorization', `Bearer ${generateTestToken(user._id)}`).expect(200);
      continueCheck();
      expect((await pending).status).toBe(401);
      expect(await Machine.countDocuments({ ownerUserId: user._id })).toBe(0);
      expect(await AgentCredential.countDocuments({ ownerUserId: user._id, status: 'active' })).toBe(0);
    } finally {
      existsSpy.mockRestore();
      continueCheck();
    }
  });

  it('a machine deletion racing registration refuses the new bearer', async () => {
    const user = await owner();
    const device = await addDevice(user, 'i');
    let continueCheck;
    let checkStarted;
    const started = new Promise((resolve) => { checkStarted = resolve; });
    const resume = new Promise((resolve) => { continueCheck = resolve; });
    const originalExists = Machine.exists.bind(Machine);
    const existsSpy = jest.spyOn(Machine, 'exists').mockImplementationOnce(async (...args) => {
      checkStarted();
      await resume;
      return originalExists(...args);
    });
    try {
      const registration = request(app).post('/api/machines')
        .set('Authorization', `Bearer ${device.token}`).send({ name: 'racing-machine' });
      const pending = registration.then((response) => response);
      await started;
      const machine = await Machine.findOne({ ownerUserId: user._id, name: 'racing-machine' });
      await request(app).delete(`/api/machines/${machine._id}`)
        .set('Authorization', `Bearer ${generateTestToken(user._id)}`).expect(200);
      continueCheck();
      expect((await pending).status).toBe(409);
      expect(await AgentCredential.countDocuments({ machineId: machine.machineId, status: 'active' })).toBe(0);
    } finally {
      existsSpy.mockRestore();
      continueCheck();
    }
  });

  it('removal catches a credential inserted after its first scan', async () => {
    const user = await owner();
    const device = await addDevice(user, 'j');
    const first = (await register(device.token, 'late-mint')).body;
    let continueDelete;
    let deleteStarted;
    const started = new Promise((resolve) => { deleteStarted = resolve; });
    const resume = new Promise((resolve) => { continueDelete = resolve; });
    const originalDelete = Machine.deleteOne.bind(Machine);
    const deleteSpy = jest.spyOn(Machine, 'deleteOne').mockImplementationOnce(async (...args) => {
      deleteStarted();
      await resume;
      return originalDelete(...args);
    });
    try {
      const deletion = request(app).delete(`/api/machines/${first.machine.id}`)
        .set('Authorization', `Bearer ${generateTestToken(user._id)}`);
      const pending = deletion.then((response) => response);
      await started;
      const late = await AgentCredential.create({
        tokenHash: hash(`cm_daemon_${'k'.repeat(32)}`), kind: 'daemon', ownerUserId: user._id,
        machineId: first.machine.machineId, scopes: ['machine:heartbeat'],
      });
      continueDelete();
      expect((await pending).status).toBe(200);
      expect(await AgentCredential.findById(late._id)).toMatchObject({ status: 'revoked' });
    } finally {
      deleteSpy.mockRestore();
      continueDelete();
    }
  });
});
