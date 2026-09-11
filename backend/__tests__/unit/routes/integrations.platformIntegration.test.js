/**
 * #1672 — the `platformIntegration` virtual named models nothing registers
 * ('TelegramIntegration', 'SlackIntegration', 'MessengerIntegration'), so the
 * first non-Discord row made Mongoose throw MissingSchemaError inside every
 * populate of it: the admin Apps list and the pod list both answered 500.
 * Integration and DiscordIntegration run on memory Mongo because the populate
 * itself is the thing under test.
 */
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

// Identity from a header so one app can be called as a member and a stranger.
// Pod stays real: the admin list populates `podId`, so the model has to be
// registered, and the pod list's canViewPod gate runs against real rows.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user') || 'bbbbbbbbbbbbbbbbbbbbbb01';
  req.user = { id };
  req.userId = id;
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

const POD = new mongoose.Types.ObjectId();
const OTHER_POD = new mongoose.Types.ObjectId();
const CREATOR = new mongoose.Types.ObjectId();
const MEMBER = 'bbbbbbbbbbbbbbbbbbbbbb01'; // the auth mock's default caller
const STRANGER = 'bbbbbbbbbbbbbbbbbbbbbb02';

let mongod;
let Pod;
let Integration;
let DiscordIntegration;
let app;

const row = (over = {}) => ({
  podId: POD,
  scope: 'pod',
  status: 'connected',
  createdBy: CREATOR,
  isActive: true,
  config: {},
  ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Pod = require('../../../models/Pod');
  Integration = require('../../../models/Integration');
  DiscordIntegration = require('../../../models/DiscordIntegration');
  const routes = require('../../../routes/integrations');
  app = express();
  app.use(express.json());
  app.use('/api/integrations', routes);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Pod.deleteMany({});
  await Integration.deleteMany({});
  await DiscordIntegration.deleteMany({});
  await Pod.create([
    { _id: POD, name: 'Ops', createdBy: CREATOR, members: [MEMBER] },
    { _id: OTHER_POD, name: 'Guild', createdBy: CREATOR, members: [MEMBER] },
  ]);
});

const seedTelegramAndDiscord = async () => {
  await Integration.create(row({ type: 'telegram', config: { chatId: '-100', chatTitle: 'Ops' } }));
  const discord = await Integration.create(row({ type: 'discord', podId: OTHER_POD }));
  await DiscordIntegration.create({
    integrationId: discord._id,
    serverId: 'srv-1',
    serverName: 'Guild',
    channelId: 'chan-1',
    channelName: 'general',
    webhookUrl: 'https://discord.com/api/webhooks/1/x',
    webhookId: '1',
    botToken: 'bot-token',
  });
  return discord;
};

describe('platformIntegration virtual (#1672)', () => {
  it('the admin list answers 200 with a Telegram row', async () => {
    await seedTelegramAndDiscord();

    const res = await request(app).get('/api/integrations/admin/all');

    expect(res.status).toBe(200);
    expect(res.body.map((entry) => entry.type).sort()).toEqual(['discord', 'telegram']);
    const telegram = res.body.find((entry) => entry.type === 'telegram');
    expect(telegram.platformIntegration == null).toBe(true);
  });

  it('the Discord row still joins its platform record', async () => {
    const discord = await seedTelegramAndDiscord();

    const res = await request(app).get('/api/integrations/admin/all');

    expect(res.status).toBe(200);
    const joined = res.body.find((entry) => entry.type === 'discord');
    expect(String(joined._id)).toBe(String(discord._id));
    expect(joined.platformIntegration).toMatchObject({ serverId: 'srv-1', channelId: 'chan-1' });
  });

  it('the integration lists never return the bot token or webhook secret', async () => {
    await seedTelegramAndDiscord();

    const admin = await request(app).get('/api/integrations/admin/all');
    const pod = await request(app).get(`/api/integrations/${OTHER_POD}`);

    expect(admin.status).toBe(200);
    expect(pod.status).toBe(200);
    for (const body of [admin.body, pod.body]) {
      const joined = body.find((entry) => entry.type === 'discord').platformIntegration;
      expect(joined).toMatchObject({ serverId: 'srv-1', webhookId: '1' });
      expect(joined).not.toHaveProperty('botToken');
      expect(joined).not.toHaveProperty('webhookUrl');
      expect(JSON.stringify(body)).not.toMatch(/bot-token|api\/webhooks/);
    }
  });

  it('the pod list answers 200 with a Telegram row', async () => {
    await seedTelegramAndDiscord();

    const res = await request(app).get(`/api/integrations/${POD}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe('telegram');
  });

  it('the pod integrations list refuses a non-member', async () => {
    await seedTelegramAndDiscord();

    const stranger = await request(app).get(`/api/integrations/${POD}`).set('x-test-user', STRANGER);
    const missing = await request(app).get(`/api/integrations/${new mongoose.Types.ObjectId()}`);

    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ message: 'Access denied' });
    expect(missing.status).toBe(404);
  });

  // Vera's 67858 probe: with the 500 gone, the pod list and the admin list
  // returned every credential the config carries. A member still sees the
  // Telegram connectCode, which is the one value the Connectors page pastes.
  it('no integration response carries a credential', async () => {
    const SECRETS = {
      botToken: 'tg-bot-token',
      secretToken: 'tg-secret-token',
      signingSecret: 'slack-signing-secret',
      accessToken: 'x-access-token',
      refreshToken: 'x-refresh-token',
      webhookUrl: 'https://hooks.slack.com/services/T1/B1/hook-secret',
      botTokenRef: 'cs_ref_1',
      oauthStateNonce: 'nonce-1',
    };
    await Integration.create([
      row({ type: 'telegram', config: { chatId: '-100', connectCode: 'CODE-1', botToken: SECRETS.botToken, secretToken: SECRETS.secretToken, botTokenRef: SECRETS.botTokenRef } }),
      row({ type: 'x', config: { username: 'ops', accessToken: SECRETS.accessToken, refreshToken: SECRETS.refreshToken } }),
      row({ type: 'slack', config: { teamId: 'T1', signingSecret: SECRETS.signingSecret, webhookUrl: SECRETS.webhookUrl, oauthStateNonce: SECRETS.oauthStateNonce, pendingBind: { teamId: 'T1', botTokenRef: SECRETS.botTokenRef } } }),
    ]);

    const admin = await request(app).get('/api/integrations/admin/all');
    const pod = await request(app).get(`/api/integrations/${POD}`);

    expect(admin.status).toBe(200);
    expect(pod.status).toBe(200);
    for (const body of [admin.body, pod.body]) {
      expect(body).toHaveLength(3);
      const configs = body.map((entry) => entry.config);
      Object.keys(SECRETS).forEach((key) => {
        configs.forEach((config) => expect(config).not.toHaveProperty(key));
      });
      const slack = body.find((entry) => entry.type === 'slack');
      expect(slack.config.pendingBind).toEqual({ teamId: 'T1' });
      const serialized = JSON.stringify(body);
      Object.values(SECRETS).forEach((value) => expect(serialized).not.toContain(value));
      expect(body.find((entry) => entry.type === 'telegram').config.connectCode).toBe('CODE-1');
    }
  });
});
