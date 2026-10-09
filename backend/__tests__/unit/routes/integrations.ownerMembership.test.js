// TASK-168 — the pod-creator arms on the connector owner routes.
//
// Measured before the fix: connect / disconnect / stats / messages / send gated
// on `pod.createdBy?.toString() === caller` and read no membership, and
// `canDeleteIntegration` admitted the pod's creator outright. `createdBy` is
// written at creation and survives `leavePod` (it filters `members`), so a
// creator who had left could still read the pod's Discord channel
// (GET /:id/messages) and post into it (POST /:id/send) after TASK-161/162 had
// closed every relay and chat path to them.
//
// Real Pod / Integration / User rows on memory Mongo: `canDeleteIntegration`
// resolves the requester and the pod itself, and `isListedPodMember` reads the
// pod document's own `members`, so a mocked doc would exercise neither. The
// Discord service is mocked at the module boundary because two of these routes
// proxy into it: the refusal arms assert the side effect did NOT happen, not
// that a status was returned.
//
// Every refusal arm has a control at the same route with a creator who IS
// listed — otherwise "refuse the creator" would pass by refusing every pod that
// names one.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: req.header('x-test-user') };
  req.userId = req.user.id;
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn(async () => true) }));
jest.mock('../../../services/discordService', () => {
  const instance = {
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ connected: true }),
    fetchMessages: jest.fn().mockResolvedValue([]),
    sendMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
  };
  const Ctor = jest.fn(() => instance);
  Ctor.__instance = instance;
  return Ctor;
});

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const DiscordService = require('../../../services/discordService');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

const as = (userId) => ({ 'x-test-user': userId });
const service = () => DiscordService.__instance;

describe('connector owner routes require listed membership, not just createdBy', () => {
  let mongod;
  let departed;
  let listedCreator;
  let bystander;
  let otherOwner;
  let departedPod;
  let listedPod;
  let handoverPod;

  const makeIntegration = (pod, createdBy) => Integration.create({
    podId: pod._id,
    scope: 'pod',
    type: 'discord',
    status: 'connected',
    createdBy,
    isActive: true,
    config: { botToken: 'test-token' },
  });

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    departed = await User.create({ username: 'departed', email: 'departed@owner-membership.test', password: 'placeholder' });
    listedCreator = await User.create({ username: 'listed', email: 'listed@owner-membership.test', password: 'placeholder' });
    bystander = await User.create({ username: 'bystander', email: 'bystander@owner-membership.test', password: 'placeholder' });
    otherOwner = await User.create({ username: 'otherOwner', email: 'other@owner-membership.test', password: 'placeholder' });
    // The pod's creator is NOT in `members`: the state `leavePod` produces, and
    // the one the census behind TASK-166 found 30 accounts in.
    //
    // It has to be produced rather than declared. `models/Pod.ts:194` pushes
    // `createdBy` into `members` for every NEW pod, so a creator who is not
    // listed is by construction one who has LEFT — passing `members: [bystander]`
    // to `Pod.create` would be silently repaired into a listed creator and these
    // arms would pass without ever reaching the predicate. `$pull` is what
    // `leavePod` does, and the hook's `isNew` guard means it does not re-add.
    departedPod = await Pod.create({ name: 'Departed Pod', createdBy: departed._id, members: [bystander._id] });
    await Pod.updateOne({ _id: departedPod._id }, { $pull: { members: departed._id } });
    listedPod = await Pod.create({ name: 'Listed Pod', createdBy: listedCreator._id, members: [listedCreator._id, bystander._id] });
    handoverPod = await Pod.create({ name: 'Handover Pod', createdBy: departed._id, members: [bystander._id] });
    await Pod.updateOne({ _id: handoverPod._id }, { $pull: { members: departed._id } });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- the five owner routes -------------------------------------------------

  test('refuses /connect for a creator who is no longer listed, and never connects', async () => {
    const integration = await makeIntegration(departedPod, otherOwner._id);
    const res = await request(app).post(`/api/integrations/${integration._id}/connect`).set(as(String(departed._id)));
    expect(res.status).toBe(403);
    expect(service().connect).not.toHaveBeenCalled();
  });

  test('refuses /disconnect for a creator who is no longer listed, and never disconnects', async () => {
    const integration = await makeIntegration(departedPod, otherOwner._id);
    const res = await request(app).post(`/api/integrations/${integration._id}/disconnect`).set(as(String(departed._id)));
    expect(res.status).toBe(403);
    expect(service().disconnect).not.toHaveBeenCalled();
  });

  test('refuses /stats for a creator who is no longer listed, and never reads stats', async () => {
    const integration = await makeIntegration(departedPod, otherOwner._id);
    const res = await request(app).get(`/api/integrations/${integration._id}/stats`).set(as(String(departed._id)));
    expect(res.status).toBe(403);
    expect(service().getStats).not.toHaveBeenCalled();
  });

  test('refuses /messages for a creator who is no longer listed, and never reads the channel', async () => {
    const integration = await makeIntegration(departedPod, otherOwner._id);
    const res = await request(app).get(`/api/integrations/${integration._id}/messages`).set(as(String(departed._id)));
    expect(res.status).toBe(403);
    expect(service().fetchMessages).not.toHaveBeenCalled();
  });

  test('refuses /send for a creator who is no longer listed, and never posts to the channel', async () => {
    const integration = await makeIntegration(departedPod, otherOwner._id);
    const res = await request(app)
      .post(`/api/integrations/${integration._id}/send`)
      .set(as(String(departed._id)))
      .send({ message: 'hello' });
    expect(res.status).toBe(403);
    expect(service().sendMessage).not.toHaveBeenCalled();
  });

  test('a listed creator is unaffected: all five owner routes still act', async () => {
    const integration = await makeIntegration(listedPod, otherOwner._id);
    const who = as(String(listedCreator._id));

    const connect = await request(app).post(`/api/integrations/${integration._id}/connect`).set(who);
    expect(connect.status).toBe(200);
    expect(service().connect).toHaveBeenCalledTimes(1);

    const disconnect = await request(app).post(`/api/integrations/${integration._id}/disconnect`).set(who);
    expect(disconnect.status).toBe(200);
    expect(service().disconnect).toHaveBeenCalledTimes(1);

    const stats = await request(app).get(`/api/integrations/${integration._id}/stats`).set(who);
    expect(stats.status).toBe(200);
    expect(service().getStats).toHaveBeenCalledTimes(1);

    const messages = await request(app).get(`/api/integrations/${integration._id}/messages`).set(who);
    expect(messages.status).toBe(200);
    expect(service().fetchMessages).toHaveBeenCalledTimes(1);

    const send = await request(app).post(`/api/integrations/${integration._id}/send`).set(who).send({ message: 'hello' });
    expect(send.status).toBe(200);
    expect(service().sendMessage).toHaveBeenCalledTimes(1);
  });

  // --- canDeleteIntegration's pod-creator arm -------------------------------

  test('refuses DELETE for a pod creator who is no longer listed, and removes nothing', async () => {
    const integration = await makeIntegration(departedPod, otherOwner._id);
    const res = await request(app).delete(`/api/integrations/${integration._id}`).set(as(String(departed._id)));
    expect(res.status).toBe(403);
    expect(await Integration.findById(integration._id)).not.toBeNull();
  });

  test('still admits a pod creator who is listed, for a connector someone else created', async () => {
    const integration = await makeIntegration(listedPod, otherOwner._id);
    const res = await request(app).delete(`/api/integrations/${integration._id}`).set(as(String(listedCreator._id)));
    expect(res.status).toBe(200);
    expect(await Integration.findById(integration._id)).toBeNull();
  });

  test('the integration-creator arm is untouched: a departed pod creator who created the connector still deletes it', async () => {
    const integration = await makeIntegration(handoverPod, departed._id);
    const res = await request(app).delete(`/api/integrations/${integration._id}`).set(as(String(departed._id)));
    expect(res.status).toBe(200);
    expect(await Integration.findById(integration._id)).toBeNull();
  });
});
