/**
 * TASK-124 — a Discord connector must not store a copy of the bot token.
 *
 * The row that stored it is what made `DISCORD_BOT_TOKEN` rotation miss
 * integrations that already existed: every read prefered the copy, so the new
 * env value reached new connectors only (Vera 73344-73346; all three
 * `discord_integrations` documents carried a 72-char copy). Step 1 of the
 * split removes the WRITE; the data step that clears the three legacy values
 * rides separately, because the field has to stay readable until it runs.
 *
 * Real Integration/DiscordIntegration/Pod rows on memory Mongo: the schema is
 * part of what is under test — `botToken` was `required: true`, so "stop
 * writing it" and "the row still saves" are one claim, and a mocked model would
 * exercise neither.
 */
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: String(req.header('x-test-user')) };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn(() => true) }));
jest.mock('../../../utils/isPodMember', () => jest.fn(() => true));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
// The create path initializes and connects the provider; only the row matters.
jest.mock('../../../services/discordService', () => jest.fn().mockImplementation(() => ({
  initialize: jest.fn().mockResolvedValue(true),
  connect: jest.fn().mockResolvedValue(true),
})));

const axios = require('axios');
const Integration = require('../../../models/Integration');
const DiscordIntegration = require('../../../models/DiscordIntegration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const integrationRoutes = require('../../../routes/integrations');

const GUILD = '123456789012345678';
const CHANNEL = '123456789012345679';
const ENV_TOKEN = 'env-token-at-connect-time';

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

describe('discord connector stores no bot token copy (TASK-124)', () => {
  let mongod;
  let pod;
  let creator;
  const savedEnv = process.env.DISCORD_BOT_TOKEN;

  const post = (body) => request(app)
    .post('/api/integrations')
    .set('x-test-user', String(creator._id))
    .send(body);

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    creator = await User.create({ username: 'creator', email: 'creator@discord-token.test', password: 'placeholder' });
    pod = await Pod.create({ name: 'Connector Ops', createdBy: creator._id, members: [creator._id] });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    process.env.DISCORD_BOT_TOKEN = ENV_TOKEN;
    await Integration.deleteMany({});
    await DiscordIntegration.deleteMany({});
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { id: 'wh-1', token: 'wh-token', name: 'Commonly Bot' } });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = savedEnv;
  });

  it('creates the connector without persisting the token, and the row still saves', async () => {
    const res = await post({
      podId: String(pod._id),
      type: 'discord',
      config: {
        serverId: GUILD, channelId: CHANNEL, channelName: 'general', serverName: 'Commonly',
      },
    });

    expect(res.status).toBe(201);

    const row = await DiscordIntegration.findOne({ channelId: CHANNEL }).lean();
    // Control first: the row exists and carries what the create path must set,
    // so the absence assertion below cannot pass on a row that was never made.
    expect(row).not.toBeNull();
    expect(row.webhookId).toBe('wh-1');
    expect(row.webhookUrl).toContain('/wh-1/');
    expect(row.serverId).toBe(GUILD);
    // The claim: no copy of the instance-wide token is stored on the row.
    expect(row.botToken).toBeUndefined();
  });

  it('does not leak the token to the client on the create response either', async () => {
    const res = await post({
      podId: String(pod._id),
      type: 'discord',
      config: {
        serverId: GUILD, channelId: CHANNEL, channelName: 'general', serverName: 'Commonly',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.platformIntegration).not.toHaveProperty('botToken');
    expect(res.body.platformIntegration).not.toHaveProperty('webhookUrl');
  });

  it('still requires a token to connect: with the env var absent the create is refused', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const res = await post({
      podId: String(pod._id),
      type: 'discord',
      config: { serverId: GUILD, channelId: CHANNEL },
    });

    // The manifest's `botToken` requirement is satisfied by the environment,
    // not by a stored copy - so its absence must still refuse, and the refusal
    // must happen before any row or webhook exists.
    expect(res.status).toBe(400);
    expect(res.body.missing).toContain('botToken');
    expect(await DiscordIntegration.countDocuments({ channelId: CHANNEL })).toBe(0);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
