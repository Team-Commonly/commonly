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
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn() }));
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

  const groupmeConfig = () => ({
    botId: 'b1c2d3e4f5a6',
    groupId: '12345678',
    groupUrl: 'https://groupme.com/join_group/12345678/AbCdEf',
    groupName: 'Study group',
  });

  it('withholds a GroupMe connector’s bot and group from a pod member who did not create it', async () => {
    await Integration.create({
      podId: pod._id, scope: 'pod', type: 'groupme', status: 'connected', createdBy: creator._id, isActive: true, config: groupmeConfig(),
    });
    const other = (await get(member._id)).body.find((row) => row.type === 'groupme');
    expect(other.config.groupName).toBe('Study group');
    expect(other.config).not.toHaveProperty('botId');
    expect(other.config).not.toHaveProperty('groupId');
    expect(other.config).not.toHaveProperty('groupUrl');
    const own = (await get(creator._id)).body.find((row) => row.type === 'groupme');
    expect(own.config).toMatchObject({ botId: 'b1c2d3e4f5a6', groupId: '12345678' });
  });

  it('keeps the stored bot and group when a pod creator saves the GroupMe form without them', async () => {
    const foreign = await Integration.create({
      podId: memberPod._id, scope: 'pod', type: 'groupme', status: 'connected', createdBy: creator._id, isActive: true, config: groupmeConfig(),
    });
    // The form sends no ids it was never given.
    const res = await request(app)
      .patch(`/api/integrations/${foreign._id}`)
      .set('x-test-user', String(member._id))
      .send({ config: { groupName: 'Renamed group', agentAccessEnabled: false }, status: 'connected' });
    expect(res.status).toBe(200);
    expect(res.body.config).not.toHaveProperty('botId');
    const stored = await Integration.findById(foreign._id).lean();
    expect(stored.config).toMatchObject({ botId: 'b1c2d3e4f5a6', groupId: '12345678', groupName: 'Renamed group' });
  });

  it('keeps a stored GroupMe token when the creator saves with the token field blank', async () => {
    const own = await Integration.create({
      podId: pod._id,
      scope: 'pod',
      type: 'groupme',
      status: 'connected',
      createdBy: creator._id,
      isActive: true,
      config: { ...groupmeConfig(), accessTokenRef: 'ref-sentinel', agentAccessEnabled: true },
    });
    const listed = (await get(creator._id)).body.find((row) => row.type === 'groupme');
    expect(listed.config.accessTokenSaved).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('ref-sentinel');

    const res = await request(app)
      .patch(`/api/integrations/${own._id}`)
      .set('x-test-user', String(creator._id))
      .send({ config: { botId: 'b1c2d3e4f5a6', groupId: '12345678', agentAccessEnabled: true }, status: 'connected' });
    expect(res.status).toBe(200);
    expect(res.body.config.accessTokenSaved).toBe(true);
    const stored = await Integration.findById(own._id).lean();
    expect(stored.config.accessTokenRef).toBe('ref-sentinel');
  });

  it('refuses to let anyone but the connector creator turn agent access on with the saved token', async () => {
    const foreign = await Integration.create({
      podId: memberPod._id,
      scope: 'pod',
      type: 'groupme',
      status: 'connected',
      createdBy: creator._id,
      isActive: true,
      config: { ...groupmeConfig(), accessTokenRef: 'ref-sentinel', agentAccessEnabled: false },
    });
    const turnOn = (userId, extra = {}) => request(app)
      .patch(`/api/integrations/${foreign._id}`)
      .set('x-test-user', String(userId))
      .send({ config: { agentAccessEnabled: true, ...extra }, status: 'connected' });

    const refused = await turnOn(member._id);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('groupme_saved_token_not_yours');
    expect((await Integration.findById(foreign._id).lean()).config.agentAccessEnabled).toBe(false);

    const blankToken = await turnOn(member._id, { accessToken: '   ' });
    expect(blankToken.status).toBe(403);

    // A value Mongoose would also store as true is refused at the edge, not cast.
    for (const value of ['true', 1, 'yes']) {
      // eslint-disable-next-line no-await-in-loop
      const cast = await request(app)
        .patch(`/api/integrations/${foreign._id}`)
        .set('x-test-user', String(member._id))
        .send({ config: { agentAccessEnabled: value }, status: 'connected' });
      expect([400, 403]).toContain(cast.status);
      // eslint-disable-next-line no-await-in-loop
      expect((await Integration.findById(foreign._id).lean()).config.agentAccessEnabled).toBe(false);
    }
    const yes = await request(app)
      .patch(`/api/integrations/${foreign._id}`)
      .set('x-test-user', String(member._id))
      .send({ config: { agentAccessEnabled: 'yes' }, status: 'connected' });
    expect(yes.status).toBe(400);
    expect(yes.body.message).toBe('agentAccessEnabled must be true or false');

    const own = await turnOn(creator._id);
    expect(own.status).toBe(200);
    const stored = await Integration.findById(foreign._id).lean();
    expect(stored.config.agentAccessEnabled).toBe(true);
    expect(stored.config.accessTokenRef).toBe('ref-sentinel');
  });

  it('lets a pod creator keep agent access on, or turn it on with their own token', async () => {
    const foreign = await Integration.create({
      podId: memberPod._id,
      scope: 'pod',
      type: 'groupme',
      status: 'connected',
      createdBy: creator._id,
      isActive: true,
      config: { ...groupmeConfig(), accessTokenRef: 'ref-sentinel', agentAccessEnabled: true },
    });
    const keep = await request(app)
      .patch(`/api/integrations/${foreign._id}`)
      .set('x-test-user', String(member._id))
      .send({ config: { groupName: 'Renamed', agentAccessEnabled: true }, status: 'connected' });
    expect(keep.status).toBe(200);

    await Integration.updateOne({ _id: foreign._id }, { $set: { 'config.agentAccessEnabled': false } });
    // A supplied token is encrypted into connector secrets, which needs a key.
    const saved = [process.env.CONNECTOR_SECRET_KEYS, process.env.CONNECTOR_SECRET_ACTIVE_KEY];
    process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 5).toString('base64')}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
    try {
      const withOwn = await request(app)
        .patch(`/api/integrations/${foreign._id}`)
        .set('x-test-user', String(member._id))
        .send({ config: { agentAccessEnabled: true, accessToken: 'members-own-token' }, status: 'connected' });
      expect(withOwn.status).toBe(200);
      const stored = await Integration.findById(foreign._id).lean();
      expect(stored.config.agentAccessEnabled).toBe(true);
      expect(stored.config.accessTokenRef).toEqual(expect.any(String));
      expect(stored.config.accessTokenRef).not.toBe('ref-sentinel');
      expect(JSON.stringify(stored)).not.toContain('members-own-token');
    } finally {
      [process.env.CONNECTOR_SECRET_KEYS, process.env.CONNECTOR_SECRET_ACTIVE_KEY] = saved;
      if (saved[0] === undefined) delete process.env.CONNECTOR_SECRET_KEYS;
      if (saved[1] === undefined) delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    }
  });

  describe('removing a saved GroupMe token', () => {
    const ConnectorSecret = require('../../../models/ConnectorSecret');
    const { storeGroupmeAccessToken } = require('../../../services/chatConnectorTokens');
    let saved;
    beforeEach(() => {
      saved = [process.env.CONNECTOR_SECRET_KEYS, process.env.CONNECTOR_SECRET_ACTIVE_KEY];
      process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 5).toString('base64')}`;
      process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
    });
    afterEach(() => {
      [process.env.CONNECTOR_SECRET_KEYS, process.env.CONNECTOR_SECRET_ACTIVE_KEY] = saved;
      if (saved[0] === undefined) delete process.env.CONNECTOR_SECRET_KEYS;
      if (saved[1] === undefined) delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    });

    const withToken = async (podId = pod._id) => {
      const row = await Integration.create({
        podId, scope: 'pod', type: 'groupme', status: 'connected', createdBy: creator._id, isActive: true,
        config: { ...groupmeConfig(), agentAccessEnabled: true },
      });
      const { accessTokenRef } = await storeGroupmeAccessToken(String(row._id), 'stored-token');
      await Integration.updateOne({ _id: row._id }, { $set: { 'config.accessTokenRef': accessTokenRef } });
      return { row, ref: accessTokenRef };
    };
    const remove = (rowId, userId) => request(app)
      .delete(`/api/integrations/${rowId}/access-token`)
      .set('x-test-user', String(userId));

    it('deletes the secret, drops the ref and turns agent access off', async () => {
      const { row, ref } = await withToken();
      expect(await ConnectorSecret.countDocuments({ _id: ref })).toBe(1);
      const res = await remove(row._id, creator._id);
      expect(res.status).toBe(200);
      expect(res.body.config).not.toHaveProperty('accessTokenSaved');
      expect(res.body.config.agentAccessEnabled).toBe(false);
      const stored = await Integration.findById(row._id).lean();
      expect(stored.config).not.toHaveProperty('accessTokenRef');
      expect(stored.config.agentAccessEnabled).toBe(false);
      expect(await ConnectorSecret.countDocuments({ _id: ref })).toBe(0);
    });

    it('lets a pod creator who did not connect it remove it, and the echo stays projected', async () => {
      const { row, ref } = await withToken(memberPod._id);
      const res = await remove(row._id, member._id);
      expect(res.status).toBe(200);
      expect(res.body.config).not.toHaveProperty('botId');
      expect(await ConnectorSecret.countDocuments({ _id: ref })).toBe(0);
    });

    it('refuses a member who cannot change the connector, and keeps the token', async () => {
      const { row, ref } = await withToken();
      const res = await remove(row._id, member._id);
      expect(res.status).toBe(403);
      expect((await Integration.findById(row._id).lean()).config.accessTokenRef).toBe(ref);
      expect(await ConnectorSecret.countDocuments({ _id: ref })).toBe(1);
    });

    it('is GroupMe only, and a row with no token just turns agent access off', async () => {
      const telegram = await Integration.findOne({ type: 'telegram' });
      expect((await remove(telegram._id, creator._id)).status).toBe(400);
      const bare = await Integration.create({
        podId: pod._id, scope: 'pod', type: 'groupme', status: 'connected', createdBy: creator._id, isActive: true,
        config: { ...groupmeConfig(), agentAccessEnabled: false },
      });
      expect((await remove(bare._id, creator._id)).status).toBe(200);
      expect((await remove('not-an-id', creator._id)).status).toBe(400);
    });
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
