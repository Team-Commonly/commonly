// Discord install and bind: a Discord bot add started from Commonly's install
// link must come back through `/api/discord/callback`, and the success page's
// two requests must then leave a bound pod. On prod 11-04 the link carried no
// `redirect_uri` and no `response_type=code`, so Discord added the bot and never
// redirected: no callback, no install proof, no Integration, and `GET /binding`
// stayed 404. This walks the whole chain against a real mongod, with Discord's
// HTTP API stubbed at axios:
//
//   install-link -> Discord authorize (asserted as a URL) -> callback(code)
//   -> /discord/success?install=<proof> -> channels(proof) -> POST integrations
//   -> GET binding
//
// The redirect the link names must be the one the callback exchanges the code
// with: Discord refuses a token exchange whose redirect_uri differs from the
// authorize request's.
/* eslint-disable global-require */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.PG_HOST = '';

const OWNER = '6a8f6de2a1dccf2e02f31401';
const MEMBER = '6a8f6de2a1dccf2e02f31402';
const POD_ID = '6a8f6de2a1dccf2e02f31499';
const GUILD = '123456789012345678';
const INSTALLER_DISCORD = '456789012345678901';
const CHANNEL = '234567890123456789';
const WEBHOOK = { id: '345678901234567890', token: 'webhook-token' };

jest.mock('../../middleware/auth', () => (req, _res, next) => {
  const token = String(req.header('Authorization') || '').replace('Bearer ', '');
  req.user = { id: token === 'member-token' ? '6a8f6de2a1dccf2e02f31402' : '6a8f6de2a1dccf2e02f31401' };
  req.userId = req.user.id;
  next();
});
jest.mock('../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../services/discordService', () => jest.fn().mockImplementation(() => ({
  initialize: jest.fn().mockResolvedValue(true),
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
})));
jest.mock('../../services/connectorSecrets', () => ({
  put: jest.fn().mockResolvedValue('secret-ref-1'),
  get: jest.fn(),
  remove: jest.fn(),
}));

let mongod;
let app;
let axios;
let Integration;
let DiscordIntegration;
let User;
let Pod;

const POD = {
  _id: POD_ID, name: 'Discord walk', type: 'team', createdBy: OWNER, members: [OWNER, MEMBER],
};

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.DISCORD_CLIENT_ID = '1111111111';
  process.env.DISCORD_CLIENT_SECRET = 'client-secret';
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  process.env.BACKEND_URL = 'https://api.example.test';
  process.env.FRONTEND_URL = 'https://app.example.test';
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  axios = require('axios');
  Integration = require('../../models/Integration');
  DiscordIntegration = require('../../models/DiscordIntegration');
  User = require('../../models/User');
  Pod = require('../../models/Pod');
  await Integration.syncIndexes();
  app = express();
  app.use(express.json());
  app.use('/api/discord', require('../../routes/discord'));
  app.use('/api/integrations', require('../../routes/integrations'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Integration.deleteMany({});
  await DiscordIntegration.deleteMany({});
  User.findById.mockImplementation(async (id) => ({ _id: String(id), role: 'user' }));
  Pod.findById.mockImplementation(async (id) => (String(id) === POD_ID ? { ...POD } : null));
  Pod.find.mockImplementation((query) => {
    const userId = String(query?.$or?.[0]?.members || '');
    const rows = POD.members.includes(userId) || POD.createdBy === userId ? [{ _id: POD_ID }] : [];
    return { select: () => ({ lean: async () => rows }) };
  });
  axios.post.mockImplementation(async (url) => {
    if (url === 'https://discord.com/api/oauth2/token') {
      return { data: { access_token: 'user-access', guild: { id: GUILD, name: 'Commonly Dev' } } };
    }
    if (url === `https://discord.com/api/channels/${CHANNEL}/webhooks`) return { data: WEBHOOK };
    throw new Error(`unexpected POST ${url}`);
  });
  axios.get.mockImplementation(async (url) => {
    if (url === `https://discord.com/api/guilds/${GUILD}`) return { data: { id: GUILD, name: 'Commonly Dev' } };
    if (url === `https://discord.com/api/guilds/${GUILD}/channels`) {
      return { data: [{ id: CHANNEL, name: 'general', type: 0 }, { id: '999999999999999999', name: 'Voice', type: 2 }] };
    }
    if (url === `https://discord.com/api/channels/${CHANNEL}`) return { data: { id: CHANNEL, guild_id: GUILD, type: 0 } };
    if (url === 'https://discord.com/api/users/@me') return { data: { id: INSTALLER_DISCORD, username: 'owner' } };
    throw new Error(`unexpected GET ${url}`);
  });
});

const CALLBACK = 'https://api.example.test/api/discord/callback';

test('the install link sends Discord back to the callback with a code', async () => {
  const res = await request(app).get(`/api/discord/install-link/${POD_ID}`).set('Authorization', 'Bearer owner-token');
  expect(res.status).toBe(200);
  const url = new URL(res.body.installUrl);
  expect(url.origin + url.pathname).toBe('https://discord.com/api/oauth2/authorize');
  expect(url.searchParams.get('client_id')).toBe('1111111111');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
  // A signed state, not the bare pod id a crafted link could carry.
  expect(url.searchParams.get('state')).not.toBe(`pod_${POD_ID}`);
  expect(url.searchParams.get('state')).not.toContain(POD_ID);
  // `identify` lets the callback read the installer's Discord user id (F131).
  expect(url.searchParams.get('scope')).toBe('bot applications.commands identify');
});

test('the link ignores a caller-supplied client id', async () => {
  const res = await request(app)
    .get(`/api/discord/install-link/${POD_ID}?clientId=2222222222`)
    .set('Authorization', 'Bearer owner-token');
  expect(res.status).toBe(200);
  expect(new URL(res.body.installUrl).searchParams.get('client_id')).toBe('1111111111');
});

test('a bot add from the link ends in a bound pod', async () => {
  const link = await request(app).get(`/api/discord/install-link/${POD_ID}`).set('Authorization', 'Bearer owner-token');
  const authorize = new URL(link.body.installUrl);
  expect((await request(app).get(`/api/discord/binding/${POD_ID}`).set('Authorization', 'Bearer owner-token')).status).toBe(404);

  // Discord redirects the browser to the link's redirect_uri with a code, the
  // state it was given and the guild the bot joined.
  const back = new URL(authorize.searchParams.get('redirect_uri'));
  const cb = await request(app)
    .get(`${back.pathname}?code=the-code&state=${authorize.searchParams.get('state')}&guild_id=${GUILD}`);
  expect(cb.status).toBe(302);
  const success = new URL(cb.headers.location);
  expect(success.origin + success.pathname).toBe('https://app.example.test/discord/success');
  expect(success.searchParams.get('pod_id')).toBe(POD_ID);
  expect(success.searchParams.get('guild_id')).toBe(GUILD);
  const proof = success.searchParams.get('install');
  expect(proof).toBeTruthy();
  // The code exchange names the same redirect the authorize request did.
  const exchange = axios.post.mock.calls.find(([url]) => url === 'https://discord.com/api/oauth2/token');
  expect(exchange[1].redirect_uri).toBe(CALLBACK);

  // The success page lists the guild's channels on the proof...
  const channels = await request(app)
    .get(`/api/discord/channels/${GUILD}?install=${encodeURIComponent(proof)}`)
    .set('Authorization', 'Bearer owner-token');
  expect(channels.status).toBe(200);
  expect(channels.body.map((c) => c.id)).toContain(CHANNEL);

  // ...and binds the one the person picks.
  const bind = await request(app)
    .post('/api/integrations')
    .set('Authorization', 'Bearer owner-token')
    .send({
      podId: POD_ID,
      type: 'discord',
      config: {
        serverId: GUILD, serverName: 'Commonly Dev', channelId: CHANNEL, channelName: 'general', webhookUrl: '', botToken: '',
      },
      install: proof,
    });
  expect(bind.status).toBe(201);

  const row = await Integration.findOne({ podId: POD_ID, type: 'discord' }).lean();
  expect(row).toBeTruthy();
  expect(String(row.createdBy)).toBe(OWNER);
  expect(row.config.serverId).toBe(GUILD);
  expect(row.config.channelId).toBe(CHANNEL);
  expect(row.config.webhookUrlRef).toBe('secret-ref-1');
  // F131: the installer's Discord id, from users/@me through the proof, survives
  // the strict config subdocument.
  expect(row.config.discordUserId).toBe(INSTALLER_DISCORD);
  const platform = await DiscordIntegration.findOne({ integrationId: row._id }).lean();
  expect(platform).toMatchObject({ serverId: GUILD, channelId: CHANNEL, webhookId: WEBHOOK.id });

  const binding = await request(app).get(`/api/discord/binding/${POD_ID}`).set('Authorization', 'Bearer owner-token');
  expect(binding.status).toBe(200);
  expect(binding.body.discordIntegration.channelId).toBe(CHANNEL);
});

test('a pod member who did not create the pod gets no install link', async () => {
  const res = await request(app).get(`/api/discord/install-link/${POD_ID}`).set('Authorization', 'Bearer member-token');
  expect(res.status).toBe(403);
});

// The callback has no session, so the state is the only thing tying a code to
// the person who asked for the install. Unsigned, a crafted link carrying an
// attacker's code and a victim's pod would mint a proof the victim's browser then
// spends binding their pod to the attacker's guild (CodeRabbit on this change).
describe('the install state and proof are bound to the person who asked', () => {
  const callback = (state) => request(app).get(`/api/discord/callback?code=the-code&state=${encodeURIComponent(state)}&guild_id=${GUILD}`);
  const errorOf = (res) => new URL(res.headers.location).pathname;

  test('a bare pod_<id> state is refused before the code is exchanged', async () => {
    const res = await callback(`pod_${POD_ID}`);
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBe('/discord/error');
    expect(axios.post.mock.calls.find(([url]) => url === 'https://discord.com/api/oauth2/token')).toBeUndefined();
  });

  test('an expired state is refused', async () => {
    const jwt = require('jsonwebtoken');
    const stale = jwt.sign({ pur: 'discord-install-state', pod: POD_ID, uid: OWNER }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await callback(stale);
    expect(errorOf(res)).toBe('/discord/error');
  });

  test("a proof minted for one person is refused for another member of the same pod", async () => {
    const link = await request(app).get(`/api/discord/install-link/${POD_ID}`).set('Authorization', 'Bearer owner-token');
    const state = new URL(link.body.installUrl).searchParams.get('state');
    const cb = await callback(state);
    const proof = new URL(cb.headers.location).searchParams.get('install');
    expect(proof).toBeTruthy();

    const channels = await request(app)
      .get(`/api/discord/channels/${GUILD}?install=${encodeURIComponent(proof)}`)
      .set('Authorization', 'Bearer member-token');
    expect(channels.status).toBe(404);

    const bind = await request(app)
      .post('/api/integrations')
      .set('Authorization', 'Bearer member-token')
      .send({
        podId: POD_ID,
        type: 'discord',
        config: {
          serverId: GUILD, serverName: 'Commonly Dev', channelId: CHANNEL, channelName: 'general', webhookUrl: '', botToken: '',
        },
        install: proof,
      });
    // A member is refused at the pod check (only the creator or an admin binds).
    expect(bind.status).toBe(403);
    expect(await Integration.findOne({ podId: POD_ID, type: 'discord' })).toBeNull();

    // An admin passes the pod check, and is still refused another person's proof.
    User.findById.mockImplementation(async (id) => ({ _id: String(id), role: String(id) === MEMBER ? 'admin' : 'user' }));
    const adminBind = await request(app)
      .post('/api/integrations')
      .set('Authorization', 'Bearer member-token')
      .send({
        podId: POD_ID,
        type: 'discord',
        config: {
          serverId: GUILD, serverName: 'Commonly Dev', channelId: CHANNEL, channelName: 'general', webhookUrl: '', botToken: '',
        },
        install: proof,
      });
    expect(adminBind.status).toBe(404);
    expect(await Integration.findOne({ podId: POD_ID, type: 'discord' })).toBeNull();
  });
});


// A channel bridge is a pod-level setting, so binding one takes the same
// authority as the install link: the pod's creator or an instance admin. The
// "you bound this guild before" arm proves authority over the GUILD, not over
// the pod, so on its own it let a plain member bridge someone else's pod.
describe('binding a Discord channel takes authority over the pod', () => {
  const MEMBERS_OWN_POD = '6a8f6de2a1dccf2e02f314ff';
  const bindAs = (token, install) => request(app)
    .post('/api/integrations')
    .set('Authorization', `Bearer ${token}`)
    .send({
      podId: POD_ID,
      type: 'discord',
      config: {
        serverId: GUILD, serverName: 'Commonly Dev', channelId: CHANNEL, channelName: 'general', webhookUrl: '', botToken: '',
      },
      ...(install ? { install } : {}),
    });

  test("a member who bound the guild to their own pod still can't bridge a pod they didn't create", async () => {
    Pod.find.mockImplementation((query) => {
      const userId = String(query?.$or?.[0]?.members || '');
      const rows = userId === MEMBER ? [{ _id: POD_ID }, { _id: MEMBERS_OWN_POD }] : [{ _id: POD_ID }];
      return { select: () => ({ lean: async () => rows }) };
    });
    await Integration.collection.insertOne({
      podId: new mongoose.Types.ObjectId(MEMBERS_OWN_POD),
      type: 'discord',
      status: 'connected',
      config: { serverId: GUILD, channelId: '777777777777777777' },
      createdBy: new mongoose.Types.ObjectId(MEMBER),
    });

    const res = await bindAs('member-token');
    expect(res.status).toBe(403);
    expect(await Integration.findOne({ podId: POD_ID, type: 'discord' })).toBeNull();
    expect(axios.post.mock.calls.find(([url]) => url.endsWith('/webhooks'))).toBeUndefined();
  });

  test('an instance admin may bind a pod they did not create, on a proof minted for them', async () => {
    User.findById.mockImplementation(async (id) => ({ _id: String(id), role: String(id) === MEMBER ? 'admin' : 'user' }));
    const link = await request(app).get(`/api/discord/install-link/${POD_ID}`).set('Authorization', 'Bearer member-token');
    expect(link.status).toBe(200);
    const state = new URL(link.body.installUrl).searchParams.get('state');
    const cb = await request(app).get(`/api/discord/callback?code=the-code&state=${encodeURIComponent(state)}&guild_id=${GUILD}`);
    const proof = new URL(cb.headers.location).searchParams.get('install');

    expect((await bindAs('member-token', proof)).status).toBe(201);
  });
});

// F161 (CodeRabbit 4475816316): "Add the bot again" on a row in error starts a
// fresh install. The new bind retires the caller's dropped row on the same pod,
// guild and channel the way Remove would, so the page doesn't show two rows.
describe('a fresh bind replaces the dropped row it reconnects', () => {
  const OTHER_CHANNEL = '456789012345678901';
  const seedRow = async (over = {}) => {
    const row = await Integration.create({
      podId: POD_ID,
      type: 'discord',
      createdBy: OWNER,
      status: 'error',
      config: { serverId: GUILD, channelId: CHANNEL, channelName: 'general' },
      ...over,
    });
    await DiscordIntegration.create({
      integrationId: row._id, serverId: GUILD, serverName: 'Commonly Dev', channelId: row.config.channelId, channelName: 'general', webhookId: 'old-hook',
    });
    return row;
  };

  const bindViaInstall = async () => {
    const link = await request(app).get(`/api/discord/install-link/${POD_ID}`).set('Authorization', 'Bearer owner-token');
    const authorize = new URL(link.body.installUrl);
    const back = new URL(authorize.searchParams.get('redirect_uri'));
    const cb = await request(app)
      .get(`${back.pathname}?code=the-code&state=${authorize.searchParams.get('state')}&guild_id=${GUILD}`);
    const proof = new URL(cb.headers.location).searchParams.get('install');
    return request(app)
      .post('/api/integrations')
      .set('Authorization', 'Bearer owner-token')
      .send({
        podId: POD_ID,
        type: 'discord',
        config: { serverId: GUILD, serverName: 'Commonly Dev', channelId: CHANNEL, channelName: 'general' },
        install: proof,
      });
  };

  test.each(['error', 'disconnected'])('a %s row on the same channel ends up inactive, its webhook record gone', async (status) => {
    const old = await seedRow({ status });
    const bind = await bindViaInstall();
    expect(bind.status).toBe(201);
    const retired = await Integration.findById(old._id).lean();
    expect(retired.isActive).toBe(false);
    expect(retired.status).toBe('disconnected');
    expect(await DiscordIntegration.findOne({ integrationId: old._id })).toBeNull();
    const DiscordService = require('../../services/discordService');
    const retiredService = DiscordService.mock.results
      .map((r, i) => ({ value: r.value, id: String(DiscordService.mock.calls[i][0]) }))
      .find((r) => r.id === String(old._id));
    expect(retiredService.value.disconnect).toHaveBeenCalled();
    const live = await Integration.find({ podId: POD_ID, type: 'discord', isActive: true }).lean();
    expect(live.map((r) => String(r._id))).toEqual([String(bind.body.integration._id)]);
  });

  test('rows the bind does not replace stay as they are', async () => {
    const otherChannel = await seedRow({ config: { serverId: GUILD, channelId: OTHER_CHANNEL } });
    const connected = await seedRow({ status: 'connected' });
    const someoneElses = await seedRow({ createdBy: MEMBER });
    const bind = await bindViaInstall();
    expect(bind.status).toBe(201);
    for (const row of [otherChannel, connected, someoneElses]) {
      // eslint-disable-next-line no-await-in-loop
      const after = await Integration.findById(row._id).lean();
      expect(after.isActive).toBe(true);
      expect(after.status).toBe(row.status);
    }
  });
});
