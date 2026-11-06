// A seat's DM rows count as installs, so a seat removed from its last pod kept
// its token, and its DMs answered, with nothing left for its owner to remove.
// Real mongod, because every claim here is about which rows a query reaches.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

jest.mock('../../models/pg/Message', () => ({
  findByPodId: jest.fn().mockResolvedValue([]),
  deleteByPodId: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService').default
  || require('../../services/agentIdentityService');
const { deletePodCascade } = require('../../services/podDeletionService');
const registryRouter = require('../../routes/registry');

const SECRET = 'agent-dm-rows-test';
const NAME = 'seat-agent';
const INSTANCE = 'seat-one';
const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;

describe('DM rows when an agent leaves its last pod', () => {
  let app; let owner; let guest; let seat; let saved; let seq = 0;

  const person = (label) => {
    seq += 1;
    return User.create({ username: `${label}-${seq}`, email: `${label}-${seq}@example.test`, password: 'x'.repeat(12) });
  };
  const pod = (name, members, type = 'chat', createdBy = members[0]) => Pod.create({ name, type, createdBy, members });
  const row = async (podDoc, installedBy, config = {}) => {
    const { insertedId } = await AgentInstallation.collection.insertOne({
      agentName: NAME, instanceId: INSTANCE, podId: podDoc._id, installedBy,
      version: '1.0.0', status: 'active', displayName: 'Seat', config,
    });
    return insertedId;
  };
  const status = async (id) => (await AgentInstallation.findById(id).lean()).status;
  const tokens = async () => (await User.findById(seat._id).lean()).agentRuntimeTokens.length;
  const remove = (user, podId) => request(app)
    .delete(`/api/registry/agents/${NAME}/pods/${podId}`).query({ instanceId: INSTANCE })
    .set('Authorization', bearer(user));

  beforeAll(async () => {
    saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRouter);
  });

  afterAll(async () => {
    process.env.JWT_SECRET = saved;
    await closeMongoDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Pod.deleteMany({}), AgentInstallation.deleteMany({})]);
    owner = await person('owner');
    guest = await person('guest');
    const type = AgentIdentityService.resolveAgentType(NAME);
    seat = await User.create({
      username: AgentIdentityService.buildAgentUsername(type, INSTANCE),
      email: `seat-${seq}@agents.test`,
      password: 'x'.repeat(12),
      isBot: true,
      botMetadata: { agentName: type, instanceId: INSTANCE, ownerUserId: owner._id },
      agentRuntimeTokens: [{ tokenHash: 'seat-token-hash', label: 'test', createdAt: new Date() }],
    });
  });

  it('ends the DM rows and the token when the owner removes the seat from its last pod', async () => {
    const origin = await pod('origin', [owner._id, seat._id]);
    await row(origin, owner._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-dm', seat._id);
    const dmRow = await row(dm, seat._id, { autoJoinSource: 'agent-dm-create' });

    const res = await remove(owner, origin._id);
    expect(res.status).toBe(200);
    expect(await status(dmRow)).toBe('uninstalled');
    expect(await tokens()).toBe(0);
  });

  it('ends them when the seat\'s last pod is deleted', async () => {
    const origin = await pod('origin', [owner._id, seat._id]);
    await row(origin, owner._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-dm', seat._id);
    const dmRow = await row(dm, seat._id, { autoJoinSource: 'agent-dm-create' });

    await deletePodCascade(String(origin._id));
    expect(await status(dmRow)).toBe('uninstalled');
    expect(await tokens()).toBe(0);
  });

  it('keeps them while the seat is in another pod', async () => {
    const origin = await pod('origin', [owner._id, seat._id]);
    const other = await pod('other', [guest._id, seat._id]);
    await row(origin, owner._id);
    await row(other, guest._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-room', seat._id);
    const dmRow = await row(dm, guest._id, { autoJoinSource: 'agent-room-create' });

    await remove(owner, origin._id);
    expect(await status(dmRow)).toBe('active');
    expect(await tokens()).toBe(1);
  });

  it('keeps them while the owner still has a DM with the seat, and that DM is theirs to end', async () => {
    const origin = await pod('origin', [owner._id, seat._id]);
    await row(origin, owner._id);
    const mine = await pod('mine', [seat._id, owner._id], 'agent-room', seat._id);
    const mineRow = await row(mine, owner._id, { autoJoinSource: 'agent-room-create' });
    const theirs = await pod('theirs', [seat._id, guest._id], 'agent-room', seat._id);
    const theirsRow = await row(theirs, guest._id, { autoJoinSource: 'agent-room-create' });

    await remove(owner, origin._id);
    expect(await status(mineRow)).toBe('active');
    expect(await status(theirsRow)).toBe('active');
    expect(await tokens()).toBe(1);

    await remove(owner, mine._id);
    expect(await status(theirsRow)).toBe('uninstalled');
    expect(await tokens()).toBe(0);
  });

  it('a guest ending their own DM ends nobody else\'s', async () => {
    const third = await person('third');
    const theirs = await pod('theirs', [seat._id, guest._id], 'agent-room', seat._id);
    await row(theirs, guest._id, { autoJoinSource: 'agent-room-create' });
    const other = await pod('other', [seat._id, third._id], 'agent-room', seat._id);
    const otherRow = await row(other, third._id, { autoJoinSource: 'agent-room-create' });

    await remove(guest, theirs._id);
    expect(await status(otherRow)).toBe('active');
    expect(await tokens()).toBe(1);
  });

  it('leaves an agent with no owner as it was', async () => {
    await User.updateOne({ _id: seat._id }, { $unset: { 'botMetadata.ownerUserId': 1 } });
    const origin = await pod('origin', [owner._id, seat._id]);
    await row(origin, owner._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-room', seat._id);
    const dmRow = await row(dm, guest._id, { autoJoinSource: 'agent-room-create' });

    await remove(owner, origin._id);
    expect(await status(dmRow)).toBe('active');
    expect(await tokens()).toBe(1);
  });

  it('a pod creator removing an owner-installed seat ends its guest DMs, as any last removal does', async () => {
    const origin = await pod('origin', [guest._id, seat._id]);
    await row(origin, owner._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-room', seat._id);
    const dmRow = await row(dm, guest._id, { autoJoinSource: 'agent-room-create' });

    expect((await remove(guest, origin._id)).status).toBe(200);
    expect(await status(dmRow)).toBe('uninstalled');
    expect(await tokens()).toBe(0);
  });

  it('does not bring back a DM reopened and ended after the seat left', async () => {
    const origin = await pod('origin', [owner._id, seat._id]);
    await row(origin, owner._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-room', seat._id);
    const dmRow = await row(dm, guest._id, { autoJoinSource: 'agent-room-create' });
    await remove(owner, origin._id);

    await AgentInstallation.upsert(NAME, dm._id, {
      version: '1.0.0', config: { autoJoinSource: 'agent-room-create' }, scopes: [], installedBy: guest._id, instanceId: INSTANCE,
    });
    expect(await status(dmRow)).toBe('active');
    expect((await remove(guest, dm._id)).status).toBe(200);

    const next = await pod('next', [owner._id]);
    await AgentInstallation.install(NAME, next._id, {
      version: '1.0.0', config: {}, scopes: [], installedBy: owner._id, instanceId: INSTANCE,
    });
    expect(await status(dmRow)).toBe('uninstalled');
  });

  it('a default-instance DM row stored with no instance id comes back too', async () => {
    await User.updateOne({ _id: seat._id }, { $set: {
      username: AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(NAME), 'default'),
      'botMetadata.instanceId': 'default',
    } });
    const dm = await pod('dm', [seat._id, guest._id], 'agent-room', seat._id);
    const { insertedId } = await AgentInstallation.collection.insertOne({
      agentName: NAME, instanceId: null, podId: dm._id, installedBy: guest._id, version: '1.0.0',
      status: 'uninstalled', displayName: 'Seat', config: {}, retiredWithAgentAt: new Date(),
    });
    const next = await pod('next', [owner._id]);
    await AgentInstallation.install(NAME, next._id, {
      version: '1.0.0', config: {}, scopes: [], installedBy: owner._id, instanceId: 'default',
    });
    expect(await status(insertedId)).toBe('active');
  });

  it('brings the DM back when the seat is installed in a pod again, and only then', async () => {
    const origin = await pod('origin', [owner._id, seat._id]);
    await row(origin, owner._id);
    const dm = await pod('dm', [seat._id, guest._id], 'agent-dm', seat._id);
    const dmRow = await row(dm, seat._id, { autoJoinSource: 'agent-dm-create' });
    const ended = await pod('ended', [seat._id, guest._id], 'agent-room', seat._id);
    const endedRow = await row(ended, guest._id, { autoJoinSource: 'agent-room-create' });
    await AgentInstallation.updateOne({ _id: endedRow }, { $set: { status: 'uninstalled' } });
    await remove(owner, origin._id);
    expect(await status(dmRow)).toBe('uninstalled');

    const fresh = await pod('fresh', [seat._id, guest._id], 'agent-dm', seat._id);
    await AgentInstallation.install(NAME, fresh._id, {
      version: '1.0.0', config: { autoJoinSource: 'agent-dm-create' }, scopes: [], installedBy: seat._id, instanceId: INSTANCE,
    });
    expect(await status(dmRow)).toBe('uninstalled');

    const next = await pod('next', [owner._id]);
    await AgentInstallation.install(NAME, next._id, {
      version: '1.0.0', config: {}, scopes: [], installedBy: owner._id, instanceId: INSTANCE,
    });
    expect(await status(dmRow)).toBe('active');
    expect(await status(endedRow)).toBe('uninstalled');
  });
});
