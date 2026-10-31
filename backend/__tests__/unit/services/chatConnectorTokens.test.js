// TASK-539: the GroupMe access token is stored through connectorSecrets, and a
// Slack row's accessToken / refreshToken copy (which nothing reads) is dropped.
// Real Mongo, real models and the real generic connector routes. Each case reads
// the RAW stored row, so a token written to `config` under any key fails.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'bbbbbbbbbbbbbbbbbbbbbb01' };
  req.userId = req.user.id;
  next();
});

const express = require('express');
const request = require('supertest');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const Integration = require('../../../models/Integration');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const integrationRoutes = require('../../../routes/integrations');
const { toPublicIntegrationConfig } = require('../../../models/integrationPublicConfig');
const { takeChatTokens, readGroupmeAccessToken } = require('../../../services/chatConnectorTokens');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const key = (fill) => Buffer.alloc(32, fill).toString('base64');
const MEMBER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const rawRow = (type) => Integration.collection.findOne({ type });

const expectNoMaterialOnRow = (row, ...materials) => {
  expect(row.config.accessToken).toBeUndefined();
  expect(row.config.refreshToken).toBeUndefined();
  const serialized = JSON.stringify(row);
  materials.forEach((material) => expect(serialized).not.toContain(material));
};

describe('GroupMe and Slack token copies', () => {
  const saved = {
    keys: process.env.CONNECTOR_SECRET_KEYS,
    activeKey: process.env.CONNECTOR_SECRET_ACTIVE_KEY,
  };
  let app;
  let pod;

  beforeAll(async () => {
    await setupMongoDb();
    await ConnectorSecret.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = saved.keys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = saved.activeKey;
  });

  beforeEach(async () => {
    await clearMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(7)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
    // The edit gate reads the caller's User row.
    await User.create({
      _id: MEMBER, username: 'chat-owner', email: 'chat-owner@example.test', password: 'unused-password',
    });
    pod = await Pod.create({ name: 'Chats', createdBy: MEMBER, members: [MEMBER] });
    app = express();
    app.use(express.json());
    app.use('/api/integrations', integrationRoutes);
  });

  it('stores a GroupMe token a generic create or edit supplies, and a blank edit keeps it', async () => {
    const created = await request(app).post('/api/integrations').send({
      podId: String(pod._id),
      type: 'groupme',
      config: {
        botId: 'bot-1', groupId: 'group-1', accessToken: 'gm-access-1', refreshToken: 'gm-refresh-1',
      },
    });
    expect(created.status).toBe(201);
    const row = await rawRow('groupme');
    expectNoMaterialOnRow(row, 'gm-access-1', 'gm-refresh-1');
    expect(row.config.botId).toBe('bot-1');
    expect(await readGroupmeAccessToken(row.config)).toBe('gm-access-1');

    const rotated = await request(app).patch(`/api/integrations/${row._id}`).send({
      config: { accessToken: 'gm-access-2', groupName: 'Group' },
    });
    expect(rotated.status).toBe(200);
    const after = await rawRow('groupme');
    expectNoMaterialOnRow(after, 'gm-access-1', 'gm-access-2');
    // The store upserts on (integrationId, kind), so a rotation keeps the ref.
    expect(after.config.accessTokenRef).toBe(row.config.accessTokenRef);
    expect(after.config.groupName).toBe('Group');
    expect(await readGroupmeAccessToken(after.config)).toBe('gm-access-2');

    // ChatRoom sends `accessToken: undefined` (dropped by JSON) or '' when the
    // field is left blank; neither may clear the stored token.
    const blank = await request(app).patch(`/api/integrations/${row._id}`).send({
      config: { accessToken: '', botId: 'bot-2' },
    });
    expect(blank.status).toBe(200);
    const kept = await rawRow('groupme');
    expect(kept.config.accessTokenRef).toBe(row.config.accessTokenRef);
    expect(kept.config.accessToken).toBeUndefined();
    expect(kept.config.botId).toBe('bot-2');
    expect(await readGroupmeAccessToken(kept.config)).toBe('gm-access-2');
  });

  it('refuses a body-supplied accessTokenRef, so a row cannot point at another row\'s secret', async () => {
    const created = await request(app).post('/api/integrations').send({
      podId: String(pod._id),
      type: 'groupme',
      config: { botId: 'bot-1', groupId: 'group-1', accessToken: 'gm-victim' },
    });
    expect(created.status).toBe(201);
    const victim = await rawRow('groupme');

    const planted = await request(app).post('/api/integrations').send({
      podId: String(pod._id),
      type: 'groupme',
      config: { botId: 'bot-9', groupId: 'group-9', accessTokenRef: victim.config.accessTokenRef },
    });
    expect(planted.status).toBe(201);
    const row = await Integration.collection.findOne({ 'config.botId': 'bot-9' });
    expect(row.config.accessTokenRef).toBeUndefined();

    const edited = await request(app).patch(`/api/integrations/${row._id}`).send({
      config: { accessTokenRef: victim.config.accessTokenRef },
    });
    expect(edited.status).toBe(200);
    expect((await Integration.collection.findOne({ _id: row._id })).config.accessTokenRef).toBeUndefined();
  });

  it('drops a Slack accessToken / refreshToken copy instead of storing it', async () => {
    const row = await Integration.create({
      podId: pod._id, type: 'slack', createdBy: MEMBER, status: 'pending', config: { channelId: 'C1' },
    });
    const edited = await request(app).patch(`/api/integrations/${row._id}`).send({
      config: { accessToken: 'slack-access-1', refreshToken: 'slack-refresh-1', channelName: 'general' },
    });
    expect(edited.status).toBe(200);
    const after = await rawRow('slack');
    expectNoMaterialOnRow(after, 'slack-access-1', 'slack-refresh-1');
    expect(after.config.channelName).toBe('general');
    expect(after.config.accessTokenRef).toBeUndefined();
    expect(await ConnectorSecret.countDocuments()).toBe(0);
  });

  it('withholds the GroupMe ref from every JSON projection', () => {
    expect(toPublicIntegrationConfig({ accessTokenRef: 'ref-1', groupId: 'g' })).toEqual({ groupId: 'g' });
  });

  it('splits the token fields out of a supplied config, keeping only GroupMe\'s access token', () => {
    const config = { accessToken: 'a', refreshToken: 'r', botId: 'b' };
    expect(takeChatTokens('groupme', config)).toEqual({ rest: { botId: 'b' }, accessToken: 'a' });
    expect(takeChatTokens('slack', config)).toEqual({ rest: { botId: 'b' } });
  });
});
