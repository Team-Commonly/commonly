// GET /api/integrations/:podId — pod members read every active connector in
// the pod, so a connector's ROUTING STATE (chatId, linkedUserId, relayMap,
// messageBuffer) is not the pod's to read. The creator and an instance
// administrator see the row whole; every other member gets `linked` (derived)
// and `chatTitle`, and the credential strip from toJSON still applies to both.
//
// POST /api/integrations — relayMap, messageBuffer and webhookListenerEnabled
// are written by the bridges, never by a browser body.
//
// Real Integration/Pod/User rows on memory Mongo: the toJSON transform and the
// newly added projection must both run, and a mocked doc would exercise
// neither.
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: req.header('x-test-user') };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn() }));
jest.mock('../../../utils/isPodMember', () => jest.fn(() => true));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));

const { MongoMemoryServer } = require('mongodb-memory-server');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const DMService = require('../../../services/dmService');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

describe('integration routing state', () => {
  let mongod;
  let pod;
  let memberPod;
  let creator;
  let member;
  let admin;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    creator = await User.create({ username: 'creator', email: 'creator@routing.test', password: 'placeholder' });
    member = await User.create({ username: 'member', email: 'member@routing.test', password: 'placeholder' });
    admin = await User.create({ username: 'admin', email: 'admin@routing.test', password: 'placeholder', role: 'admin' });
    pod = await Pod.create({ name: 'Routing Ops', createdBy: creator._id, members: [creator._id, member._id, admin._id] });
    // A pod whose CREATOR is `member`, holding a connector `member` did not
    // create: the shape canDeleteIntegration admits to the write routes without
    // making `member` the connector's creator.
    memberPod = await Pod.create({ name: 'Member Pod', createdBy: member._id, members: [member._id, creator._id] });
  });

  const routingConfig = () => ({
    chatId: '-1004444',
    chatTitle: 'Ops',
    chatType: 'private',
    linkedUserId: String(creator._id),
    relayMap: [{ tgMessageId: '900', agentUsername: 'kai', podMessageId: 'p-900' }],
    messageBuffer: [{ messageId: 'm-1', content: 'buffered line' }],
    liveRelay: true,
    accessToken: 'SENTINEL_ACCESS_TOKEN',
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Integration.deleteMany({});
    DMService.canViewPod.mockResolvedValue(true);
    await Integration.create({
      podId: pod._id,
      scope: 'pod',
      type: 'telegram',
      status: 'connected',
      createdBy: creator._id,
      isActive: true,
      // Every routing field the bridge owns, plus one credential that must
      // never leave the server on either path.
      config: routingConfig(),
    });
  });

  const get = (userId) => request(app).get(`/api/integrations/${pod._id}`).set('x-test-user', String(userId));

  it('redacts routing state from a pod member who is not the connector creator', async () => {
    const res = await get(member._id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const { config } = res.body[0];
    expect(config.linked).toBe(true);
    expect(config.chatTitle).toBe('Ops');
    expect(config).not.toHaveProperty('chatId');
    expect(config).not.toHaveProperty('linkedUserId');
    expect(config).not.toHaveProperty('relayMap');
    expect(config).not.toHaveProperty('messageBuffer');
    // The credential strip is not what redacts routing state, and it still runs.
    expect(config).not.toHaveProperty('accessToken');
  });

  it('shows the connector creator the routing state, with the same credential strip', async () => {
    const res = await get(creator._id);
    expect(res.status).toBe(200);
    const { config } = res.body[0];
    expect(config.chatId).toBe('-1004444');
    expect(config.linkedUserId).toBe(String(creator._id));
    expect(config.relayMap).toHaveLength(1);
    expect(config.messageBuffer).toHaveLength(1);
    expect(config.linked).toBe(true);
    expect(config).not.toHaveProperty('accessToken');
  });

  it('shows an instance administrator the routing state', async () => {
    const res = await get(admin._id);
    expect(res.status).toBe(200);
    const { config } = res.body[0];
    expect(config.chatId).toBe('-1004444');
    expect(config.relayMap).toHaveLength(1);
    expect(config).not.toHaveProperty('accessToken');
  });

  it('reports an unlinked connector as linked: false, not as absent', async () => {
    await Integration.updateOne({}, { $unset: { 'config.chatId': 1 } });
    const res = await get(member._id);
    expect(res.status).toBe(200);
    expect(res.body[0].config.linked).toBe(false);
  });

  // A connector's row is echoed by the write routes too, and the write gate is
  // not the read gate: canDeleteIntegration admits the POD's creator, who may
  // not have created this connector. Unprojected, a no-op PATCH handed that
  // member back every field the pod read withholds.
  it('redacts routing state from the PATCH echo for a pod creator who is not the connector creator', async () => {
    const foreign = await Integration.create({
      podId: memberPod._id, scope: 'pod', type: 'telegram', status: 'connected', createdBy: creator._id, isActive: true, config: routingConfig(),
    });
    const res = await request(app)
      .patch(`/api/integrations/${foreign._id}`)
      .set('x-test-user', String(member._id))
      .send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    const { config } = res.body;
    expect(config.linked).toBe(true);
    expect(config.chatTitle).toBe('Ops');
    expect(config).not.toHaveProperty('chatId');
    expect(config).not.toHaveProperty('linkedUserId');
    expect(config).not.toHaveProperty('relayMap');
    expect(config).not.toHaveProperty('messageBuffer');
    expect(config).not.toHaveProperty('accessToken');
  });

  it('shows the connector creator the routing state in the PATCH echo', async () => {
    const own = await Integration.create({
      podId: memberPod._id, scope: 'pod', type: 'telegram', status: 'connected', createdBy: creator._id, isActive: true, config: routingConfig(),
    });
    const res = await request(app)
      .patch(`/api/integrations/${own._id}`)
      .set('x-test-user', String(creator._id))
      .send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.config.chatId).toBe('-1004444');
    expect(res.body.config.linkedUserId).toBe(String(creator._id));
    expect(res.body.config.linked).toBe(true);
    expect(res.body.config).not.toHaveProperty('accessToken');
  });

  it('redacts routing state from the connect-code echo, keeping the code itself', async () => {
    const unbound = await Integration.create({
      podId: memberPod._id,
      scope: 'pod',
      type: 'telegram',
      status: 'pending',
      createdBy: creator._id,
      isActive: true,
      config: { chatTitle: 'Ops', chatType: 'private', linkedUserId: String(creator._id), liveRelay: true },
    });
    const res = await request(app)
      .post(`/api/integrations/${unbound._id}/connect-code`)
      .set('x-test-user', String(member._id));
    expect(res.status).toBe(200);
    expect(typeof res.body.config.connectCode).toBe('string');
    expect(res.body.config.connectCode).toHaveLength(32);
    expect(res.body.config.linked).toBe(false);
    expect(res.body.config.chatTitle).toBe('Ops');
    expect(res.body.config).not.toHaveProperty('linkedUserId');
  });

  it('strips relayMap, messageBuffer and webhookListenerEnabled from a client write', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .set('x-test-user', String(member._id))
      .send({
        podId: String(pod._id),
        type: 'telegram',
        config: {
          liveRelay: true,
          relayMap: [{ tgMessageId: 'forged', agentUsername: 'attacker' }],
          messageBuffer: [{ messageId: 'forged', content: 'injected' }],
          webhookListenerEnabled: true,
        },
      });
    expect(res.status).toBe(201);
    const saved = await Integration.findById(res.body.integration._id);
    expect(saved.config.liveRelay).toBe(true);
    expect(saved.config.relayMap || []).toHaveLength(0);
    expect(saved.config.messageBuffer || []).toHaveLength(0);
    expect(saved.config.webhookListenerEnabled).toBe(false);
  });
});
