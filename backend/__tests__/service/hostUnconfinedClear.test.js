// A seat that ran with no sandbox marks itself, and its own token can't lift
// the mark. Its owner can, once the seat has moved to a host that confines it.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { hash } = require('../../utils/secret');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Machine = require('../../models/Machine').default || require('../../models/Machine');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { judgeSeatConfinement } = require('../../services/seatGrantConfinement');
const registryRoutes = require('../../routes/registry');

const SECRET = 'host-unconfined-clear-test';
const NAME = 'moved-seat';

describe('clearing the mark a seat left on itself', () => {
  let app; let owner; let other; let seat; let pod; let saved; let seq = 0;

  const person = (label) => {
    seq += 1;
    return User.create({ username: `${label}-${seq}`, email: `${label}-${seq}@test.invalid`, password: 'password123' });
  };
  const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;
  const clear = (user, podId = pod._id, name = NAME) => request(app)
    .delete(`/api/registry/pods/${podId}/agents/${name}/host-unconfined`)
    .set('Authorization', bearer(user));
  const marked = async () => (await User.findById(seat._id).lean()).botMetadata.hostUnconfined === true;
  const row = (installedBy, overrides = {}) => AgentInstallation.collection.insertOne({
    agentName: NAME, instanceId: 'default', podId: pod._id, installedBy, version: '1.0.0', status: 'active',
    createdAt: new Date(), config: { runtime: { runtimeType: 'wrapper' } }, ...overrides,
  });

  beforeAll(async () => {
    saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
  });

  afterAll(async () => {
    process.env.JWT_SECRET = saved;
    await closeMongoDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Pod.deleteMany({}), AgentInstallation.deleteMany({}), Machine.deleteMany({})]);
    owner = await person('owner');
    other = await person('other');
    seat = await User.create({
      username: NAME, email: `${NAME}@agents.test`, password: 'password123', isBot: true, botType: 'agent',
      botMetadata: { agentName: NAME, instanceId: 'default', hostUnconfined: true },
    });
    pod = await Pod.create({ name: 'Home', type: 'chat', createdBy: owner._id, members: [owner._id, other._id, seat._id] });
  });

  it('lets the owner clear it, and the seat is judged afresh', async () => {
    await row(owner._id);
    expect((await judgeSeatConfinement({ agentUserId: String(seat._id), agentName: NAME })).hostUnconfined).toBe(true);

    const res = await clear(owner);

    expect(res.status).toBe(200);
    expect(await marked()).toBe(false);
    expect((await judgeSeatConfinement({ agentUserId: String(seat._id), agentName: NAME })).hostUnconfined).toBeUndefined();
  });

  it('refuses a pod member who does not own the agent', async () => {
    await row(owner._id);
    expect((await clear(other)).status).toBe(403);
    expect(await marked()).toBe(true);
  });

  it('refuses the seat itself, even on a user token it holds', async () => {
    await AgentInstallation.collection.insertOne({
      agentName: NAME, instanceId: 'default', podId: pod._id, installedBy: seat._id, version: '1.0.0', status: 'active',
      createdAt: new Date(), config: {},
    });
    await User.updateOne({ _id: seat._id }, { $set: { apiTokenHash: hash('cm_seat_user_token') } });
    const res = await request(app)
      .delete(`/api/registry/pods/${pod._id}/agents/${NAME}/host-unconfined`)
      .set('Authorization', 'Bearer cm_seat_user_token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only a person can clear this');
    expect(await marked()).toBe(true);
  });

  it('refuses someone outside the pod', async () => {
    await row(owner._id);
    const outsider = await person('outsider');
    expect((await clear(outsider)).status).toBe(403);
    expect(await marked()).toBe(true);
  });

  it('answers 404 for an agent not in the pod', async () => {
    expect((await clear(owner)).status).toBe(404);
    expect(await marked()).toBe(true);
  });

  it('says a machine that reports no sandbox still decides, and clears only the mark', async () => {
    await row(owner._id);
    await Machine.create({ ownerUserId: owner._id, machineId: 'win-1', name: 'Win', hostUnconfined: true });
    await User.updateOne({ _id: seat._id }, { $set: { 'botMetadata.machineId': 'win-1' } });

    const res = await clear(owner);

    expect(res.status).toBe(200);
    expect(res.body.machineUnconfined).toBe(true);
    expect(await marked()).toBe(false);
    expect((await judgeSeatConfinement({ agentUserId: String(seat._id), agentName: NAME })).hostUnconfined).toBe(true);
  });

  it('names what actually happened in each refusal', async () => {
    await row(owner._id);
    const judged = await judgeSeatConfinement({ agentUserId: String(seat._id), agentName: NAME });
    expect(judged.refusal.detail).toContain('ran without a sandbox');
    expect(judged.refusal.detail).not.toContain('Windows');

    await Machine.create({ ownerUserId: owner._id, machineId: 'win-1', name: 'Win', hostUnconfined: true });
    await User.updateOne({ _id: seat._id }, { $set: { 'botMetadata.machineId': 'win-1' }, $unset: { 'botMetadata.hostUnconfined': 1 } });
    const onMachine = await judgeSeatConfinement({ agentUserId: String(seat._id), agentName: NAME });
    expect(onMachine.refusal.detail).toContain('native Windows');
  });
});
