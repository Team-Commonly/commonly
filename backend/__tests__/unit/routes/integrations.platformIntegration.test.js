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

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'admin-1' };
  req.userId = 'admin-1';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

const POD = new mongoose.Types.ObjectId();
const OTHER_POD = new mongoose.Types.ObjectId();
const CREATOR = new mongoose.Types.ObjectId();

let mongod;
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
  await Integration.deleteMany({});
  await DiscordIntegration.deleteMany({});
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

  it('the Discord join never returns the bot token or the webhook URL', async () => {
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
});
